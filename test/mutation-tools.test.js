const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { IMessageServer } = require('../index');

function appleDateFromNow(secondsAgo = 0) {
  const appleEpochSeconds = Date.parse('2001-01-01T00:00:00Z') / 1000;
  return Math.round(((Date.now() / 1000) - secondsAgo - appleEpochSeconds) * 1000000000);
}

function createTempMessagesDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imessage-mutation-test-'));
  const dbPath = path.join(dir, 'chat.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      text TEXT,
      attributedBody BLOB,
      is_from_me INTEGER,
      cache_has_attachments INTEGER,
      date INTEGER,
      handle_id INTEGER,
      service TEXT
    );
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    CREATE TABLE chat_recoverable_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE attachment (
      ROWID INTEGER PRIMARY KEY,
      filename TEXT,
      mime_type TEXT,
      transfer_name TEXT,
      total_bytes INTEGER
    );
  `);

  db.prepare('INSERT INTO chat (ROWID, chat_identifier, display_name) VALUES (?, ?, ?)').run(1, '+15550000001', null);
  db.prepare('INSERT INTO chat (ROWID, chat_identifier, display_name) VALUES (?, ?, ?)').run(2, '+15550000002', 'Second Lead');
  db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(1, '+15550000001');
  db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(2, '+15550000002');
  db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(1, 1);
  db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(2, 2);

  const insertMessage = db.prepare(`
    INSERT INTO message (ROWID, guid, text, attributedBody, is_from_me, cache_has_attachments, date, handle_id, service)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertMessage.run(10, 'guid-10', 'Original outbound', null, 1, 0, appleDateFromNow(30), 1, 'iMessage');
  insertMessage.run(11, 'guid-11', 'Incoming reply', null, 0, 0, appleDateFromNow(20), 1, 'iMessage');
  insertMessage.run(12, 'guid-12', 'Old outbound', null, 1, 0, appleDateFromNow(3600), 1, 'iMessage');
  insertMessage.run(13, 'guid-13', 'SMS outbound', null, 1, 0, appleDateFromNow(30), 1, 'SMS');
  insertMessage.run(20, 'guid-20', 'Second chat message', null, 1, 0, appleDateFromNow(10), 2, 'iMessage');

  db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(1, 10);
  db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(1, 11);
  db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(1, 12);
  db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(1, 13);
  db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(2, 20);
  db.prepare('INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)').run(10, 100);
  db.close();

  return { dbPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function createServer(dbPath, options = {}) {
  const server = new IMessageServer({
    runScript: options.runScript || (() => {}),
    backupMessagesDb: options.backupMessagesDb || (() => ({
      backup_dir: '/tmp/mock-backups',
      primary_backup: '/tmp/mock-backups/chat.db.mock',
      files: ['/tmp/mock-backups/chat.db.mock'],
    })),
  });
  server.openDatabase = (dbOptions = {}) => new Database(dbPath, { readonly: dbOptions.readonly !== false });
  server.resolveHandleToName = handle => handle;
  server.sleep = async () => {};
  return server;
}

function parseResponse(response) {
  return JSON.parse(response.content[0].text);
}

async function listedToolNames(server) {
  const handler = server.server._requestHandlers.get('tools/list');
  const response = await handler({ method: 'tools/list', params: {} });
  return response.tools.map(tool => tool.name);
}

test('mutation and experimental UI tools are hidden until release flags are enabled', async () => {
  const fixture = createTempMessagesDb();
  try {
    const server = createServer(fixture.dbPath);

    assert.equal((await listedToolNames(server)).includes('delete_messages'), false);
    assert.equal((await listedToolNames(server)).includes('edit_message'), false);

    server.releaseFlags.add('message_mutation_tools');
    assert.equal((await listedToolNames(server)).includes('delete_messages'), true);
    assert.equal((await listedToolNames(server)).includes('delete_threads'), true);
    assert.equal((await listedToolNames(server)).includes('edit_message'), false);

    server.releaseFlags.add('experimental_message_ui_actions');
    assert.equal((await listedToolNames(server)).includes('edit_message'), true);
    assert.equal((await listedToolNames(server)).includes('undo_send_message'), true);
  } finally {
    fixture.cleanup();
  }
});

test('delete_messages is disabled without the mutation release flag', async () => {
  const fixture = createTempMessagesDb();
  try {
    const server = createServer(fixture.dbPath);
    const body = parseResponse(await server.deleteMessages({ message_ids: ['10'] }));

    assert.equal(body.ok, false);
    assert.match(body.error, /message_mutation_tools/);
  } finally {
    fixture.cleanup();
  }
});

test('edit and undo-send are disabled without the experimental UI release flag', async () => {
  const fixture = createTempMessagesDb();
  try {
    const server = createServer(fixture.dbPath);

    assert.match(parseResponse(await server.editMessage({ message_id: '10', new_text: 'Edited' })).error, /experimental_message_ui_actions/);
    assert.match(parseResponse(await server.undoSendMessage({ message_id: '10' })).error, /experimental_message_ui_actions/);
  } finally {
    fixture.cleanup();
  }
});

test('delete_messages deletes exact rows and joins without confirmation', async () => {
  const fixture = createTempMessagesDb();
  try {
    const server = createServer(fixture.dbPath);
    server.releaseFlags.add('message_mutation_tools');

    const body = parseResponse(await server.deleteMessages({ message_ids: ['10', '999'] }));

    assert.deepEqual(body.deleted_ids, ['10']);
    assert.deepEqual(body.missing_ids, ['999']);
    assert.equal(body.backup.primary_backup, '/tmp/mock-backups/chat.db.mock');

    const db = new Database(fixture.dbPath, { readonly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM message WHERE ROWID = 10').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chat_message_join WHERE message_id = 10').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM message_attachment_join WHERE message_id = 10').get().count, 0);
    db.close();
  } finally {
    fixture.cleanup();
  }
});

test('delete_threads previews one token and rejects changed ordered requests', async () => {
  const fixture = createTempMessagesDb();
  try {
    const server = createServer(fixture.dbPath);
    server.releaseFlags.add('message_mutation_tools');

    const preview = parseResponse(await server.deleteThreads({ chat_ids: [1, 2] }));
    assert.equal(preview.deleted, false);
    assert.equal(preview.threads.length, 2);
    assert.match(preview.approval_token, /^[a-f0-9]{24}$/);

    const rejected = await server.deleteThreads({
      chat_ids: [2, 1],
      confirm: true,
      approval_token: preview.approval_token,
    });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /does not match/);
  } finally {
    fixture.cleanup();
  }
});

test('delete_threads confirm deletes the exact approved batch in one request', async () => {
  const fixture = createTempMessagesDb();
  try {
    const server = createServer(fixture.dbPath);
    server.releaseFlags.add('message_mutation_tools');

    const preview = parseResponse(await server.deleteThreads({ chat_ids: [1, 2] }));
    const body = parseResponse(await server.deleteThreads({
      chat_ids: [1, 2],
      confirm: true,
      approval_token: preview.approval_token,
    }));

    assert.equal(body.deleted, true);
    assert.deepEqual(body.deleted_chat_ids, [1, 2]);

    const db = new Database(fixture.dbPath, { readonly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chat WHERE ROWID IN (1, 2)').get().count, 0);
    db.close();
  } finally {
    fixture.cleanup();
  }
});

test('edit_message rejects invalid messages and reports verification failure', async () => {
  const fixture = createTempMessagesDb();
  try {
    const server = createServer(fixture.dbPath);
    server.releaseFlags.add('experimental_message_ui_actions');

    await assert.rejects(
      () => server.editMessage({ message_id: '11', new_text: 'Edited' }),
      /incoming/
    );
    await assert.rejects(
      () => server.editMessage({ message_id: '13', new_text: 'Edited' }),
      /only supports iMessage/
    );
    await assert.rejects(
      () => server.editMessage({ message_id: '10', new_text: ' ' }),
      /new_text/
    );
    await assert.rejects(
      () => server.editMessage({ message_id: '12', new_text: 'Edited' }),
      /time window/
    );
    await assert.rejects(
      () => server.editMessage({ message_id: '10', new_text: 'Edited' }),
      /verification failed/
    );
  } finally {
    fixture.cleanup();
  }
});

test('edit_message calls UI automation and verifies changed DB text', async () => {
  const fixture = createTempMessagesDb();
  try {
    const scripts = [];
    const server = createServer(fixture.dbPath, {
      runScript: script => {
        scripts.push(script);
        const db = new Database(fixture.dbPath);
        db.prepare('UPDATE message SET text = ? WHERE ROWID = 10').run('Edited outbound');
        db.close();
      },
    });
    server.releaseFlags.add('experimental_message_ui_actions');

    const body = parseResponse(await server.editMessage({ message_id: '10', new_text: 'Edited outbound' }));

    assert.equal(body.ok, true);
    assert.equal(body.verification, 'chat_db_text_matches_new_text');
    assert.equal(scripts.length, 1);
    assert.match(scripts[0], /Edit/);
  } finally {
    fixture.cleanup();
  }
});

test('undo_send_message calls UI automation and verifies row removal', async () => {
  const fixture = createTempMessagesDb();
  try {
    const scripts = [];
    const server = createServer(fixture.dbPath, {
      runScript: script => {
        scripts.push(script);
        const db = new Database(fixture.dbPath);
        db.prepare('DELETE FROM chat_message_join WHERE message_id = 10').run();
        db.prepare('DELETE FROM message WHERE ROWID = 10').run();
        db.close();
      },
    });
    server.releaseFlags.add('experimental_message_ui_actions');

    const body = parseResponse(await server.undoSendMessage({ message_id: '10' }));

    assert.equal(body.ok, true);
    assert.equal(body.verification, 'message_row_removed');
    assert.equal(scripts.length, 1);
    assert.match(scripts[0], /Undo Send/);
  } finally {
    fixture.cleanup();
  }
});

test('undo_send_message rejects invalid messages and reports verification failure', async () => {
  const fixture = createTempMessagesDb();
  try {
    const server = createServer(fixture.dbPath);
    server.releaseFlags.add('experimental_message_ui_actions');

    await assert.rejects(
      () => server.undoSendMessage({ message_id: '11' }),
      /incoming/
    );
    await assert.rejects(
      () => server.undoSendMessage({ message_id: '13' }),
      /only supports iMessage/
    );
    await assert.rejects(
      () => server.undoSendMessage({ message_id: '12' }),
      /time window/
    );
    await assert.rejects(
      () => server.undoSendMessage({ message_id: '10' }),
      /verification failed/
    );
  } finally {
    fixture.cleanup();
  }
});
