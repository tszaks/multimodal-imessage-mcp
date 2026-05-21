const crypto = require('crypto');

const DEFAULT_MAX_BATCH_SIZE = 25;

function normalizeRecipient(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

function canonicalizeBatch(items, service = 'sms') {
  return {
    service,
    items: (items || []).map(item => ({
      to: String(item.to || '').trim(),
      message: String(item.message || ''),
      candidate_id: item.candidate_id ? String(item.candidate_id) : null,
      risk_level: item.risk_level || null,
      risk_labels: Array.isArray(item.risk_labels) ? item.risk_labels.map(String).sort() : [],
    })),
  };
}

function createApprovalToken(items, service = 'sms') {
  const canonical = canonicalizeBatch(items, service);
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex')
    .slice(0, 24);
}

function validateBatch(items, options = {}) {
  const maxItems = options.maxItems || DEFAULT_MAX_BATCH_SIZE;
  const errors = [];
  const warnings = [];

  if (!Array.isArray(items)) {
    return { ok: false, errors: ['items must be an array'], warnings };
  }

  if (items.length === 0) {
    errors.push('batch is empty');
  }

  if (items.length > maxItems) {
    errors.push(`batch has ${items.length} items, max is ${maxItems}`);
  }

  const seen = new Set();
  items.forEach((item, index) => {
    const to = String(item?.to || '').trim();
    const message = String(item?.message || '').trim();
    const normalizedTo = normalizeRecipient(to);

    if (!to) errors.push(`item ${index + 1} is missing to`);
    if (!message) errors.push(`item ${index + 1} is missing message`);

    if (normalizedTo) {
      if (seen.has(normalizedTo)) {
        errors.push(`duplicate recipient: ${to}`);
      }
      seen.add(normalizedTo);
    }

    const labels = Array.isArray(item?.risk_labels) ? item.risk_labels : [];
    if (item?.risk_level === 'high' || labels.length > 0) {
      warnings.push({
        index,
        to,
        candidate_id: item?.candidate_id || null,
        risk_level: item?.risk_level || 'high',
        risk_labels: labels.map(String),
      });
    }
  });

  return { ok: errors.length === 0, errors, warnings };
}

module.exports = {
  DEFAULT_MAX_BATCH_SIZE,
  canonicalizeBatch,
  createApprovalToken,
  normalizeRecipient,
  validateBatch,
};
