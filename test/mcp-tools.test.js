const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { IMessageServer } = require('../index');

function appleDate(iso) {
  const appleEpochSeconds = Date.parse('2001-01-01T00:00:00Z') / 1000;
  return Math.round((Date.parse(iso) / 1000 - appleEpochSeconds) * 1000000000);
}

function createMessageDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      text TEXT,
      attributedBody BLOB,
      is_from_me INTEGER,
      cache_has_attachments INTEGER,
      date INTEGER,
      handle_id INTEGER
    );
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    CREATE TABLE attachment (
      ROWID INTEGER PRIMARY KEY,
      filename TEXT,
      mime_type TEXT,
      transfer_name TEXT,
      total_bytes INTEGER
    );
  `);

  db.prepare('INSERT INTO chat (ROWID, chat_identifier, display_name) VALUES (?, ?, ?)').run(1, '+15550000001', null);
  db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(1, '+15550000001');
  db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(1, 1);
  db.prepare('INSERT INTO message (ROWID, text, attributedBody, is_from_me, cache_has_attachments, date, handle_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    1,
    'I built a quick demo website for your business.',
    null,
    1,
    0,
    appleDate('2026-05-21T12:00:00Z'),
    null
  );
  db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(1, 1);
  db.prepare('INSERT INTO message (ROWID, text, attributedBody, is_from_me, cache_has_attachments, date, handle_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    2,
    'How much?',
    null,
    0,
    0,
    appleDate('2026-05-21T12:05:00Z'),
    1
  );
  db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(1, 2);
  return db;
}

test('extractTextFromAttributedBody decodes little-endian extended lengths', () => {
  const server = new IMessageServer({ runScript: () => {} });
  const text = 'A'.repeat(260);
  const prefix = Buffer.from('streamtypedXXXXNSString');
  const marker = Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, 0x81, 0x04, 0x01]);
  const body = Buffer.concat([prefix, marker, Buffer.from(text, 'utf8')]);

  assert.equal(server.extractTextFromAttributedBody(body), text);
});

test('get_conversation_by_chat_id returns structured messages without phone lookup', async () => {
  const server = new IMessageServer({ runScript: () => {} });
  const db = createMessageDb();
  server.openDatabase = () => db;
  server.resolveHandleToName = handle => handle || 'Unknown';

  const response = await server.getConversationByChatId({ chat_id: 1, limit: 10 });
  const body = JSON.parse(response.content[0].text);

  assert.equal(body.conversation.chat_id, 1);
  assert.equal(body.conversation.handles[0].handle, '+15550000001');
  assert.equal(body.conversation.messages.length, 2);
  assert.equal(body.conversation.messages[0].decoded_text, 'I built a quick demo website for your business.');
  assert.equal(body.conversation.messages[1].from_me, false);
});

test('send_message_batch previews then sends with a matching token and mocked sender', async () => {
  const scripts = [];
  const server = new IMessageServer({ runScript: script => scripts.push(script) });
  const items = [
    { to: '+15550000001', message: 'Thanks for replying. Want me to send pricing?' },
    { to: '+15550000002', message: 'Following up on the demo site I sent.' },
  ];

  const previewResponse = await server.sendMessageBatch({ items, service: 'sms' });
  const preview = JSON.parse(previewResponse.content[0].text);
  assert.equal(preview.sent, false);
  assert.equal(preview.count, 2);

  const sendResponse = await server.sendMessageBatch({
    items,
    service: 'sms',
    confirm: true,
    approval_token: preview.approval_token,
  });
  const sent = JSON.parse(sendResponse.content[0].text);

  assert.equal(sent.sent, true);
  assert.equal(sent.count, 2);
  assert.equal(scripts.length, 2);
});

test('send_message_batch refuses a mismatched approval token', async () => {
  const server = new IMessageServer({ runScript: () => assert.fail('should not send') });
  const response = await server.sendMessageBatch({
    items: [{ to: '+15550000001', message: 'Follow-up' }],
    service: 'sms',
    confirm: true,
    approval_token: 'wrong',
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /does not match/);
});
