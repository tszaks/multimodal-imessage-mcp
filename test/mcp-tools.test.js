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
      date_read INTEGER,
      handle_id INTEGER,
      service TEXT
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
  db.prepare('INSERT INTO chat (ROWID, chat_identifier, display_name) VALUES (?, ?, ?)').run(2, '+15550000002', null);
  db.prepare('INSERT INTO chat (ROWID, chat_identifier, display_name) VALUES (?, ?, ?)').run(3, '+15550000003', null);
  db.prepare('INSERT INTO chat (ROWID, chat_identifier, display_name) VALUES (?, ?, ?)').run(4, 'chat123', 'Group Chat');
  db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(1, '+15550000001');
  db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(2, '+15550000002');
  db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(3, '+15550000003');
  db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(4, '+15550000004');
  db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(1, 1);
  db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(2, 2);
  db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(3, 3);
  db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(4, 1);
  db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(4, 4);

  const insertMessage = db.prepare(`
    INSERT INTO message (ROWID, text, attributedBody, is_from_me, cache_has_attachments, date, date_read, handle_id, service)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertMessage.run(
    1,
    'I built a quick demo website for your business.',
    null,
    1,
    0,
    appleDate('2026-05-21T12:00:00Z'),
    appleDate('2026-05-21T12:01:00Z'),
    1,
    'iMessage'
  );
  db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(1, 1);
  insertMessage.run(
    2,
    'How much?',
    null,
    0,
    0,
    appleDate('2026-05-21T12:05:00Z'),
    appleDate('2026-05-21T12:06:00Z'),
    1,
    'iMessage'
  );
  db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(1, 2);
  insertMessage.run(
    3,
    'RCS outreach',
    null,
    1,
    0,
    appleDate('2026-05-21T12:10:00Z'),
    appleDate('2026-05-21T12:11:00Z'),
    2,
    'RCS'
  );
  db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(2, 3);
  insertMessage.run(
    4,
    'SMS outreach',
    null,
    1,
    0,
    appleDate('2026-05-21T12:15:00Z'),
    appleDate('2026-05-21T12:16:00Z'),
    3,
    'SMS'
  );
  db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(3, 4);
  insertMessage.run(
    5,
    'Group outreach',
    null,
    1,
    0,
    appleDate('2026-05-21T12:20:00Z'),
    appleDate('2026-05-21T12:21:00Z'),
    1,
    'iMessage'
  );
  db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(4, 5);
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
  assert.equal(Object.hasOwn(body.conversation.messages[0], 'read_receipt_status'), false);
});

test('read receipts are exposed only behind release flag for eligible outgoing one-to-one iMessage and RCS messages', async () => {
  const server = new IMessageServer({ runScript: () => {} });
  const db = createMessageDb();
  server.openDatabase = () => db;
  server.resolveHandleToName = handle => handle || 'Unknown';
  server.releaseFlags.add('read_receipts');

  const response = await server.getConversationByChatId({ chat_id: 1, limit: 10 });
  const body = JSON.parse(response.content[0].text);
  const outgoing = body.conversation.messages[0];
  const incoming = body.conversation.messages[1];

  assert.equal(outgoing.service, 'iMessage');
  assert.equal(outgoing.read_receipt_supported, true);
  assert.equal(outgoing.read_receipt_status, 'read');
  assert.equal(typeof outgoing.date_read, 'string');
  assert.equal(outgoing.apple_date_read, appleDate('2026-05-21T12:01:00Z'));
  assert.equal(incoming.read_receipt_supported, false);
  assert.equal(incoming.read_receipt_status, 'unsupported');
  assert.equal(incoming.date_read, null);
});

test('read receipts support RCS but not SMS or group chats', async () => {
  async function readChat(chatId) {
    const server = new IMessageServer({ runScript: () => {} });
    const db = createMessageDb();
    server.openDatabase = () => db;
    server.resolveHandleToName = handle => handle || 'Unknown';
    server.releaseFlags.add('read_receipts');
    return JSON.parse((await server.getConversationByChatId({ chat_id: chatId, limit: 10 })).content[0].text)
      .conversation.messages[0];
  }

  const rcs = await readChat(2);
  const sms = await readChat(3);
  const group = await readChat(4);

  assert.equal(rcs.service, 'RCS');
  assert.equal(rcs.read_receipt_supported, true);
  assert.equal(rcs.read_receipt_status, 'read');
  assert.equal(sms.service, 'SMS');
  assert.equal(sms.read_receipt_supported, false);
  assert.equal(sms.read_receipt_status, 'unsupported');
  assert.equal(group.service, 'iMessage');
  assert.equal(group.read_receipt_supported, false);
  assert.equal(group.read_receipt_status, 'unsupported');
});

test('list_chats_structured includes last-message read receipt metadata when release flag is enabled', async () => {
  const server = new IMessageServer({ runScript: () => {} });
  const db = createMessageDb();
  server.openDatabase = () => db;
  server.resolveHandleToName = handle => handle || 'Unknown';
  server.releaseFlags.add('read_receipts');

  const response = await server.listChatsStructured({ limit: 4 });
  const body = JSON.parse(response.content[0].text);
  const rcsChat = body.chats.find(chat => chat.chat_id === 2);

  assert.equal(rcsChat.last_message.service, 'RCS');
  assert.equal(rcsChat.last_message.read_receipt_supported, true);
  assert.equal(rcsChat.last_message.read_receipt_status, 'read');
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

test('auto SMS fallback runs failed iMessage cleanup when release flag is enabled', async () => {
  const server = new IMessageServer({ runScript: () => {} });
  server.releaseFlags.add('cleanup_failed_imessage_after_sms_fallback');
  const calls = [];

  server.getServiceEvidence = () => ({ recommended_service: 'auto' });
  server.sendAndVerify = async (to, message, service) => {
    calls.push(service);
    if (service === 'imessage') {
      return {
        service,
        delivery_status: 'failed',
        delivery_evidence: { guid: 'failed-guid', message_id: '42' },
      };
    }
    return { service, delivery_status: 'sent' };
  };
  server.cleanupFailedImessageAfterSmsFallback = async (to, message, attempt) => ({
    attempted: true,
    ok: true,
    failed_message_guid: attempt.delivery_evidence.guid,
  });

  const result = await server.sendResolvedMessageWithVerification('+15550000001', 'Hello', 'auto');

  assert.deepEqual(calls, ['imessage', 'sms']);
  assert.equal(result.service, 'sms');
  assert.equal(result.fallback_from, 'imessage');
  assert.equal(result.cleanup_failed_imessage.ok, true);
  assert.match(result.text, /Failed iMessage cleanup: deleted/);
});

test('auto SMS fallback leaves failed iMessage alone without cleanup release flag', async () => {
  const server = new IMessageServer({ runScript: () => {} });
  let cleanupCalled = false;

  server.getServiceEvidence = () => ({ recommended_service: 'auto' });
  server.sendAndVerify = async (to, message, service) => {
    if (service === 'imessage') {
      return {
        service,
        delivery_status: 'failed',
        delivery_evidence: { guid: 'failed-guid', message_id: '42' },
      };
    }
    return { service, delivery_status: 'sent' };
  };
  server.cleanupFailedImessageAfterSmsFallback = async () => {
    cleanupCalled = true;
    return { attempted: true, ok: true };
  };

  const result = await server.sendResolvedMessageWithVerification('+15550000001', 'Hello', 'auto');

  assert.equal(result.service, 'sms');
  assert.equal(result.cleanup_failed_imessage, undefined);
  assert.equal(cleanupCalled, false);
});
