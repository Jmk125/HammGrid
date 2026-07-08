const NUMBER_PATTERN = /^[A-Z]{1,2}-?\d+(\.\d+)?$/i;
const CONFIDENCE_THRESHOLD = 70;
const TITLE_SIMILARITY_THRESHOLD = 0.3;

function normalizeNumber(str) {
  return (str || '').trim().toUpperCase().replace(/\s+/g, '');
}

function titleSimilarity(a, b) {
  const wordsOf = (s) =>
    new Set(
      (s || '')
        .toUpperCase()
        .replace(/[^A-Z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
    );
  const setA = wordsOf(a);
  const setB = wordsOf(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function deriveDiscipline(sheetNumber, prefixMap) {
  const normalized = normalizeNumber(sheetNumber);
  const prefixes = Object.keys(prefixMap).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (normalized.startsWith(prefix.toUpperCase())) {
      return prefixMap[prefix];
    }
  }
  return null;
}

function needsAttention(staged) {
  if (staged.match_status === 'pending') return true;
  const number = staged.corrected_number || staged.ocr_number || '';
  if (!NUMBER_PATTERN.test(number.trim())) return true;
  if ((staged.ocr_number_confidence ?? 0) < CONFIDENCE_THRESHOLD) return true;
  if ((staged.ocr_title_confidence ?? 0) < CONFIDENCE_THRESHOLD) return true;
  return false;
}

// Buckets an incoming sheet against the project's existing (published) sheets.
function computeMatch(db, projectId, number, title, prefixMap) {
  const normalized = normalizeNumber(number);
  const discipline = deriveDiscipline(normalized, prefixMap);

  if (!normalized) {
    return { match_status: 'suspicious', match_sheet_id: null, discipline };
  }

  const existing = db
    .prepare(
      `SELECT s.id, sv.title FROM sheets s
       LEFT JOIN sheet_versions sv ON sv.id = s.current_version_id
       WHERE s.project_id = ? AND UPPER(REPLACE(s.sheet_number, ' ', '')) = ?`
    )
    .get(projectId, normalized);

  if (!existing) {
    return { match_status: 'new', match_sheet_id: null, discipline };
  }

  const similarity = titleSimilarity(existing.title, title);
  if (existing.title && similarity < TITLE_SIMILARITY_THRESHOLD) {
    return { match_status: 'suspicious', match_sheet_id: existing.id, discipline };
  }

  return { match_status: 'replacement', match_sheet_id: existing.id, discipline };
}

module.exports = {
  NUMBER_PATTERN,
  CONFIDENCE_THRESHOLD,
  normalizeNumber,
  titleSimilarity,
  deriveDiscipline,
  needsAttention,
  computeMatch,
};
