// Safe arithmetic expression evaluator for take-off output formulas
// (e.g. "takeoff * Wall_Height", "(takeoff * Foundation_Width *
// Foundation_Height) / 27"). Hand-written recursive-descent parser over a
// deliberately tiny grammar - numbers, identifiers, + - * / and parens only.
// No eval/new Function, no property access, no function calls: the
// tokenizer rejects any other character outright, so there's no way for a
// formula string (user-authored, stored in the DB, later run in any
// viewer's browser) to do anything but arithmetic.

function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j])) j++;
      const text = input.slice(i, j);
      if (!/^\d+(\.\d+)?$|^\.\d+$/.test(text)) throw new Error(`Invalid number "${text}"`);
      tokens.push({ type: 'NUMBER', value: parseFloat(text) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j++;
      tokens.push({ type: 'IDENT', value: input.slice(i, j) });
      i = j;
      continue;
    }
    const single = { '+': 'PLUS', '-': 'MINUS', '*': 'STAR', '/': 'SLASH', '(': 'LPAREN', ')': 'RPAREN' }[ch];
    if (!single) throw new Error(`Unexpected character "${ch}"`);
    tokens.push({ type: single });
    i++;
  }
  tokens.push({ type: 'EOF' });
  return tokens;
}

function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const consume = (type) => {
    const t = tokens[pos];
    if (t.type !== type) throw new Error(`Expected ${type} but found ${t.type === 'EOF' ? 'end of formula' : t.type}`);
    pos++;
    return t;
  };

  function parseExpression() {
    let node = parseTerm();
    while (peek().type === 'PLUS' || peek().type === 'MINUS') {
      const op = consume(peek().type).type;
      node = { type: 'BinOp', op, left: node, right: parseTerm() };
    }
    return node;
  }
  function parseTerm() {
    let node = parseFactor();
    while (peek().type === 'STAR' || peek().type === 'SLASH') {
      const op = consume(peek().type).type;
      node = { type: 'BinOp', op, left: node, right: parseFactor() };
    }
    return node;
  }
  function parseFactor() {
    if (peek().type === 'MINUS') {
      consume('MINUS');
      return { type: 'Neg', operand: parseFactor() };
    }
    if (peek().type === 'LPAREN') {
      consume('LPAREN');
      const node = parseExpression();
      consume('RPAREN');
      return node;
    }
    if (peek().type === 'NUMBER') return { type: 'Number', value: consume('NUMBER').value };
    if (peek().type === 'IDENT') return { type: 'Ident', name: consume('IDENT').value };
    throw new Error(peek().type === 'EOF' ? 'Formula ends unexpectedly' : `Unexpected "${peek().type}"`);
  }

  const node = parseExpression();
  if (peek().type !== 'EOF') throw new Error('Unexpected trailing text after a complete expression');
  return node;
}

function evaluateNode(node, variables) {
  switch (node.type) {
    case 'Number':
      return node.value;
    case 'Neg':
      return -evaluateNode(node.operand, variables);
    case 'Ident':
      if (!(node.name in variables)) throw new Error(`Unknown variable "${node.name}"`);
      return variables[node.name];
    case 'BinOp': {
      const l = evaluateNode(node.left, variables);
      const r = evaluateNode(node.right, variables);
      if (node.op === 'PLUS') return l + r;
      if (node.op === 'MINUS') return l - r;
      if (node.op === 'STAR') return l * r;
      if (node.op === 'SLASH') return l / r;
      throw new Error('Invalid operator');
    }
    default:
      throw new Error('Invalid expression');
  }
}

// { ok: true, value } | { ok: false, error }
export function evaluateFormula(formula, variables) {
  if (!formula || !formula.trim()) return { ok: false, error: 'No formula' };
  try {
    const value = evaluateNode(parse(tokenize(formula)), variables);
    if (!Number.isFinite(value)) return { ok: false, error: 'Result is not a finite number (check for divide-by-zero)' };
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// "Wall Height" -> "Wall_Height" - the identifier usable inside a formula.
export function slugifyPropertyName(name) {
  let slug = String(name || '')
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) slug = 'Property';
  if (/^[0-9]/.test(slug)) slug = `_${slug}`;
  return slug;
}

export const RESERVED_VARIABLE_NAME = 'takeoff';

// "[Width] x [Height] Footing" + [{name:"Width",value:2},{name:"Height",value:2.5}]
// -> "2 x 2.5 Footing". Matched against the property's display name (not
// its slug), case-insensitively, so it reads naturally when typing a name
// by hand. An unmatched bracket (typo, or a property that got removed) is
// left as literal text rather than silently disappearing - a wrong name is
// obvious, a name that's silently missing a chunk is not.
export function resolveTakeoffName(nameTemplate, properties) {
  if (!nameTemplate) return nameTemplate;
  return nameTemplate.replace(/\[([^\]]+)\]/g, (match, propName) => {
    const prop = (properties || []).find((p) => p.name && p.name.trim().toLowerCase() === propName.trim().toLowerCase());
    return prop ? String(prop.value) : match;
  });
}

export function parseTakeoffProperties(propertiesJson) {
  try {
    const parsed = typeof propertiesJson === 'string' ? JSON.parse(propertiesJson) : propertiesJson;
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

// The single entry point everywhere a take-off total is displayed. Never
// throws - a malformed/missing formula just falls back to the raw quantity
// so a bad formula can never break the pane or the totals page.
export function computeTakeoffOutput(item, rawQuantity) {
  if (!item || !item.formula) return { value: rawQuantity, isOutput: false, label: null };
  const properties = parseTakeoffProperties(item.properties);
  const variables = { [RESERVED_VARIABLE_NAME]: rawQuantity };
  for (const p of properties) {
    variables[slugifyPropertyName(p.name)] = Number(p.value) || 0;
  }
  const result = evaluateFormula(item.formula, variables);
  if (!result.ok) return { value: rawQuantity, isOutput: false, label: null };
  return { value: result.value, isOutput: true, label: item.output_label || null };
}
