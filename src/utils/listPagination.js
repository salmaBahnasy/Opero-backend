const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

function clampListLimit(value, { fallback = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.trunc(n), max);
}

module.exports = {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  clampListLimit,
};
