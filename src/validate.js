// Small declarative validator — enough structure for consistent 400s
// without pulling in a schema library.
//
// Rule shape: { required, type: 'string'|'number'|'integer'|'boolean'|'object'|'array',
//               min, max, minLen, maxLen, enum, pattern }

const { ApiError } = require('./errors');

function validate(body, rules) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw ApiError.badRequest('Request body must be a JSON object');
  }
  const errors = [];
  const out = {};

  for (const [field, rule] of Object.entries(rules)) {
    let value = body[field];

    if (value === undefined || value === null || value === '') {
      if (rule.required) errors.push({ field, message: 'is required' });
      else if (rule.default !== undefined) out[field] = rule.default;
      continue;
    }

    switch (rule.type) {
      case 'string':
        if (typeof value !== 'string') { errors.push({ field, message: 'must be a string' }); continue; }
        value = value.trim();
        if (rule.minLen && value.length < rule.minLen) errors.push({ field, message: `must be at least ${rule.minLen} characters` });
        if (rule.maxLen && value.length > rule.maxLen) errors.push({ field, message: `must be at most ${rule.maxLen} characters` });
        if (rule.pattern && !rule.pattern.test(value)) errors.push({ field, message: rule.patternMessage || 'has an invalid format' });
        break;
      case 'integer':
      case 'number':
        value = Number(value);
        if (!Number.isFinite(value) || (rule.type === 'integer' && !Number.isInteger(value))) {
          errors.push({ field, message: `must be ${rule.type === 'integer' ? 'an integer' : 'a number'}` });
          continue;
        }
        if (rule.min !== undefined && value < rule.min) errors.push({ field, message: `must be >= ${rule.min}` });
        if (rule.max !== undefined && value > rule.max) errors.push({ field, message: `must be <= ${rule.max}` });
        break;
      case 'boolean':
        if (typeof value !== 'boolean') { errors.push({ field, message: 'must be a boolean' }); continue; }
        break;
      case 'object':
        if (typeof value !== 'object' || Array.isArray(value)) { errors.push({ field, message: 'must be an object' }); continue; }
        break;
      case 'array':
        if (!Array.isArray(value)) { errors.push({ field, message: 'must be an array' }); continue; }
        if (rule.minLen && value.length < rule.minLen) errors.push({ field, message: `must have at least ${rule.minLen} items` });
        if (rule.maxLen && value.length > rule.maxLen) errors.push({ field, message: `must have at most ${rule.maxLen} items` });
        break;
      default:
        break;
    }

    if (rule.enum && !rule.enum.includes(value)) {
      errors.push({ field, message: `must be one of: ${rule.enum.join(', ')}` });
    }
    out[field] = value;
  }

  if (errors.length) {
    throw ApiError.badRequest('Validation failed', errors);
  }
  return out;
}

// Parses ?page & ?limit with sane bounds; returns limit/offset for SQL.
function pagination(query, { defaultPageSize, maxPageSize }) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxPageSize, Math.max(1, parseInt(query.limit, 10) || defaultPageSize));
  return { page, limit, offset: (page - 1) * limit };
}

module.exports = { validate, pagination };
