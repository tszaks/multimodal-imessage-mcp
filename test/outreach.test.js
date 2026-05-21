const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyConversation } = require('../lib/outreach');

const now = new Date('2026-05-21T18:00:00');

function message(id, date, fromMe, text) {
  return {
    message_id: String(id),
    date,
    from_me: fromMe,
    handle: fromMe ? null : '+15550000001',
    display_name: fromMe ? 'You' : '+15550000001',
    decoded_text: text,
  };
}

function chat(messages) {
  return {
    chat_id: 10,
    display_name: '+15550000001',
    handles: [{ handle: '+15550000001', display_name: '+15550000001' }],
    is_group: false,
    messages,
  };
}

test('classifies a positive reply as a follow-up candidate', () => {
  const result = classifyConversation(chat([
    message(1, '2026-05-21 12:00:00', true, 'Hey, I built a quick demo website for your business on Google.'),
    message(2, '2026-05-21 12:10:00', false, 'Yes send me more info.'),
  ]), { now, hours_ago: 168 });

  assert.equal(result.status, 'candidate');
  assert.equal(result.actionable, true);
  assert.equal(result.confidence, 'high');
});

test('labels opt-out replies as high-risk without blocking them', () => {
  const result = classifyConversation(chat([
    message(1, '2026-05-21 12:00:00', true, 'I built a demo site for your business.'),
    message(2, '2026-05-21 12:05:00', false, 'STOP'),
  ]), { now, hours_ago: 168 });

  assert.equal(result.status, 'negative_or_opt_out');
  assert.equal(result.actionable, true);
  assert.equal(result.risk_level, 'high');
  assert.deepEqual(result.risk_labels, ['stop']);
});

test('surfaces ambiguous replies in aggressive mode', () => {
  const result = classifyConversation(chat([
    message(1, '2026-05-21 12:00:00', true, 'I built a quick website demo for your business.'),
    message(2, '2026-05-21 12:04:00', false, 'What is this?'),
  ]), { now, hours_ago: 168 });

  assert.equal(result.status, 'unclear');
  assert.equal(result.actionable, true);
  assert.equal(result.risk_level, 'medium');
});

test('excludes threads Tyler already followed up on', () => {
  const result = classifyConversation(chat([
    message(1, '2026-05-21 12:00:00', true, 'I built a demo site for your business.'),
    message(2, '2026-05-21 12:05:00', false, 'How much does it cost?'),
    message(3, '2026-05-21 12:07:00', true, 'Happy to explain pricing.'),
  ]), { now, hours_ago: 168 });

  assert.equal(result.status, 'already_followed_up');
  assert.equal(result.actionable, false);
});

test('marks outreach with no reply as awaiting reply', () => {
  const result = classifyConversation(chat([
    message(1, '2026-05-21 12:00:00', true, 'I built a quick website demo for your business.'),
  ]), { now, hours_ago: 168 });

  assert.equal(result.status, 'awaiting_reply');
  assert.equal(result.actionable, false);
});
