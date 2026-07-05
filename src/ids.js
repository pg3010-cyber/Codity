const crypto = require('crypto');

// Prefixed UUIDs make ids self-describing in logs and API payloads
// (e.g. job_5f3a…, wrk_91bc…) at no storage cost worth worrying about.
function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

module.exports = { id };
