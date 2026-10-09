// Server-side validation for take-off item/template "properties" (named
// numeric constants used by an output formula - see
// public/js/takeoffFormula.js for the client-side formula evaluator itself,
// which is the only thing that ever actually runs a formula; this file only
// checks the property list shape so bad data can't get stored).
const RESERVED_VARIABLE_NAME = 'takeoff';

function slugifyPropertyName(name) {
  let slug = String(name || '')
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) slug = 'Property';
  if (/^[0-9]/.test(slug)) slug = `_${slug}`;
  return slug;
}

// Returns { ok: true, properties: [{name, value}] } or { ok: false, error }.
function validateTakeoffProperties(rawProperties) {
  if (rawProperties === undefined) return { ok: true, properties: [] };
  if (!Array.isArray(rawProperties)) return { ok: false, error: 'properties must be an array' };

  const properties = [];
  const slugs = [];
  for (const p of rawProperties) {
    const name = p && typeof p.name === 'string' ? p.name.trim() : '';
    const value = Number(p && p.value);
    if (!name) return { ok: false, error: 'Every property needs a name' };
    if (!Number.isFinite(value)) return { ok: false, error: `"${name}" needs a numeric value` };
    const slug = slugifyPropertyName(name);
    if (slug === RESERVED_VARIABLE_NAME) {
      return { ok: false, error: `A property can't be named "${RESERVED_VARIABLE_NAME}"` };
    }
    if (slugs.includes(slug)) return { ok: false, error: `Property names must be unique ("${slug}" is used more than once)` };
    slugs.push(slug);
    properties.push({ name, value });
  }
  return { ok: true, properties };
}

module.exports = { validateTakeoffProperties, slugifyPropertyName, RESERVED_VARIABLE_NAME };
