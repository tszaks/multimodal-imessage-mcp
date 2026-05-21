const test = require('node:test');
const assert = require('node:assert/strict');
const { createApprovalToken, validateBatch } = require('../lib/batch');

test('approval token changes when a message changes', () => {
  const first = createApprovalToken([
    { to: '+15550000001', message: 'First follow-up' },
  ], 'sms');
  const second = createApprovalToken([
    { to: '+15550000001', message: 'Changed follow-up' },
  ], 'sms');

  assert.notEqual(first, second);
});

test('batch validation rejects more than 25 items', () => {
  const items = Array.from({ length: 26 }, (_, index) => ({
    to: `+155500000${String(index).padStart(2, '0')}`,
    message: 'Follow-up',
  }));

  const result = validateBatch(items);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /max is 25/);
});

test('batch validation rejects duplicate recipients', () => {
  const result = validateBatch([
    { to: '+15550000001', message: 'One' },
    { to: '+1 555 000 0001', message: 'Two' },
  ]);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /duplicate recipient/);
});

test('batch validation flags high-risk candidates without rejecting them', () => {
  const result = validateBatch([
    {
      to: '+15550000001',
      message: 'Checking back in',
      candidate_id: '10:1:2',
      risk_level: 'high',
      risk_labels: ['stop'],
    },
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(result.warnings[0].risk_labels, ['stop']);
});
