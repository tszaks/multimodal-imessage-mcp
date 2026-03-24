#!/usr/bin/env node
// imessage-mcp HTTP server — self-contained HTTP wrapper
// Wraps the iMessage functionality in an MCP-over-HTTP server.
// Requires macOS (Messages, AddressBook SQLite, osascript).
// ENV: PORT (default 3000), MCP_API_KEY (required)
//
// Start: MCP_API_KEY=your-secret-key PORT=3000 node http-server.js
// Then expose with: cloudflared tunnel --url http://localhost:3000

const express = require('express');
const { randomUUID } = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const VERSION = '1.3.0';
const MCP_API_KEY = process.env.MCP_API_KEY;

if (!MCP_API_KEY) {
  throw new Error('Missing required env var: MCP_API_KEY');
}

const DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');

function extractTextFromAttributedBody(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  const marker = Buffer.from('NSString');
  const idx = buf.indexOf(marker);
  if (idx === -1) return null;
  let pos = idx + marker.length;
  const searchEnd = Math.min(pos + 12, buf.length);
  while (pos < searchEnd) { if (buf[pos] === 0x2b) break; pos++; }
  if (pos >= buf.length || buf[pos] !== 0x2b) return null;
  pos++;
  if (pos >= buf.length) return null;
  let textLen = buf[pos]; pos++;
  if (textLen === 0x81 && pos + 2 <= buf.length) { textLen = (buf[pos] << 8) | buf[pos + 1]; pos += 2; }
  else if (textLen === 0x82 && pos + 4 <= buf.length) { textLen = (buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]; pos += 4; }
  if (textLen <= 0 || pos + textLen > buf.length) return null;
  return buf.slice(pos, pos + textLen).toString('utf-8');
}

function getMessageText(msg) {
  if (msg.text) return msg.text;
  if (msg.attributedBody) return extractTextFromAttributedBody(msg.attributedBody);
  return null;
}

function resolveAttachmentPath(filename) {
  if (!filename) return null;
  if (filename.startsWith('~')) return path.join(os.homedir(), filename.slice(1));
  return filename;
}

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.heic': 'image/heic', '.heif': 'image/heif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4' };
  return mimeMap[ext] || 'application/octet-stream';
}

function normalizePhoneNumber(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7) return null;
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

function getAddressBookPaths() {
  const abRoot = path.join(os.homedir(), 'Library', 'Application Support', 'AddressBook', 'Sources');
  if (!fs.existsSync(abRoot)) return [];
  try { return fs.readdirSync(abRoot).map(d => path.join(abRoot, d, 'AddressBook-v22.abcddb')).filter(p => fs.existsSync(p)); }
  catch { return []; }
}

function buildDisplayName(row) {
  const first = (row.ZFIRSTNAME || '').trim(); const last = (row.ZLASTNAME || '').trim();
  const org = (row.ZORGANIZATION || '').trim(); const nick = (row.ZNICKNAME || '').trim();
  if (first && last) return `${first} ${last}`;
  if (first) return first; if (nick) return nick; if (last) return last; if (org) return org;
  return null;
}

let _contactCache = null, _nameToHandles = null, _cacheInitialized = false;

function buildContactCache() {
  const handleToContact = new Map(); const nameToHandles = new Map();
  for (const dbPath of getAddressBookPaths()) {
    let db; try { db = new Database(dbPath, { readonly: true, fileMustExist: true }); } catch { continue; }
    try {
      for (const row of db.prepare('SELECT r.Z_PK,r.ZFIRSTNAME,r.ZLASTNAME,r.ZORGANIZATION,r.ZNICKNAME,p.ZFULLNUMBER FROM ZABCDRECORD r JOIN ZABCDPHONENUMBER p ON p.ZOWNER=r.Z_PK WHERE (r.ZFIRSTNAME IS NOT NULL OR r.ZLASTNAME IS NOT NULL OR r.ZORGANIZATION IS NOT NULL)').all()) {
        const n = normalizePhoneNumber(row.ZFULLNUMBER); if (!n) continue;
        const dn = buildDisplayName(row); if (!dn) continue;
        handleToContact.set(n, { displayName: dn });
        const key = dn.toLowerCase(); if (!nameToHandles.has(key)) nameToHandles.set(key, new Set()); nameToHandles.get(key).add(n);
        const first = (row.ZFIRSTNAME || '').trim().toLowerCase(); if (first) { if (!nameToHandles.has(first)) nameToHandles.set(first, new Set()); nameToHandles.get(first).add(n); }
      }
      for (const row of db.prepare('SELECT r.Z_PK,r.ZFIRSTNAME,r.ZLASTNAME,r.ZORGANIZATION,r.ZNICKNAME,e.ZADDRESS FROM ZABCDRECORD r JOIN ZABCDEMAILADDRESS e ON e.ZOWNER=r.Z_PK WHERE (r.ZFIRSTNAME IS NOT NULL OR r.ZLASTNAME IS NOT NULL OR r.ZORGANIZATION IS NOT NULL)').all()) {
        if (!row.ZADDRESS) continue; const ne = row.ZADDRESS.toLowerCase().trim();
        const dn = buildDisplayName(row); if (!dn) continue;
        handleToContact.set(ne, { displayName: dn });
        const key = dn.toLowerCase(); if (!nameToHandles.has(key)) nameToHandles.set(key, new Set()); nameToHandles.get(key).add(ne);
      }
    } catch { } finally { db.close(); }
  }
  return { handleToContact, nameToHandles };
}

function ensureContactCache() {
  if (_cacheInitialized) return;
  try { const { handleToContact, nameToHandles } = buildContactCache(); _contactCache = handleToContact; _nameToHandles = nameToHandles; }
  catch { _contactCache = new Map(); _nameToHandles = new Map(); }
  _cacheInitialized = true;
}

function resolveHandleToName(handleId) {
  if (!handleId) return 'Unknown'; ensureContactCache();
  if (handleId.includes('@')) { const c = _contactCache.get(handleId.toLowerCase().trim()); return c ? c.displayName : handleId; }
  const n = normalizePhoneNumber(handleId); if (n) { const c = _contactCache.get(n); return c ? c.displayName : handleId; }
  return handleId;
}

function resolveNameToHandleIds(name) {
  if (!name) return []; ensureContactCache();
  const lower = name.toLowerCase().trim();
  if (_nameToHandles.has(lower)) return Array.from(_nameToHandles.get(lower));
  const matches = []; for (const [k, s] of _nameToHandles) { if (k.includes(lower) || lower.includes(k)) matches.push(...s); }
  return [...new Set(matches)];
}

function openDatabase() {
  try { return new Database(DB_PATH, { readonly: true }); }
  catch (e) { throw new Error(`Failed to open iMessage database: ${e.message}`); }
}

async function readRecentMessages({ limit = 50, include_group_chats = true }) {
  const db = openDatabase();
  const msgs = db.prepare(`SELECT m.ROWID,m.text,m.attributedBody,m.is_from_me,m.cache_has_attachments,datetime(m.date/1000000000+strftime('%s','2001-01-01'),'unixepoch','localtime') as date,h.id as contact,c.display_name as chat_name,c.chat_identifier FROM message m LEFT JOIN handle h ON m.handle_id=h.ROWID LEFT JOIN chat_message_join cmj ON m.ROWID=cmj.message_id LEFT JOIN chat c ON cmj.chat_id=c.ROWID WHERE (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)${include_group_chats ? '' : " AND (c.chat_identifier IS NULL OR c.chat_identifier NOT LIKE '%chat%')"} ORDER BY m.date DESC LIMIT ?`).all(limit);
  db.close();
  const text = msgs.map(msg => { const from = msg.is_from_me ? 'You' : resolveHandleToName(msg.contact); const chatInfo = msg.chat_name ? ` (${msg.chat_name})` : ''; const t = getMessageText(msg) || ''; const att = msg.cache_has_attachments ? ' \u{1F4CE}' : ''; return `[${msg.date}] ${from}${chatInfo}: ${t}${att}`; }).filter(l => !l.endsWith(': ')).join('\n\n');
  return { content: [{ type: 'text', text: text || 'No recent messages found.' }] };
}

async function searchMessages({ query, limit = 25 }) {
  const db = openDatabase();
  const resolvedHandles = resolveNameToHandleIds(query);
  let handleClause = '';
  if (resolvedHandles.length > 0) {
    const allHandles = db.prepare('SELECT ROWID,id FROM handle').all();
    const matchingRowIds = allHandles.filter(h => { const hn = h.id.includes('@') ? h.id.toLowerCase().trim() : normalizePhoneNumber(h.id); return hn && resolvedHandles.includes(hn); }).map(h => h.ROWID);
    if (matchingRowIds.length > 0) handleClause = `OR m.handle_id IN (${matchingRowIds.join(',')})`;
  }
  const pat = `%${query}%`;
  const msgs = db.prepare(`SELECT m.ROWID,m.text,m.attributedBody,m.is_from_me,m.cache_has_attachments,datetime(m.date/1000000000+strftime('%s','2001-01-01'),'unixepoch','localtime') as date,h.id as contact,c.display_name as chat_name FROM message m LEFT JOIN handle h ON m.handle_id=h.ROWID LEFT JOIN chat_message_join cmj ON m.ROWID=cmj.message_id LEFT JOIN chat c ON cmj.chat_id=c.ROWID WHERE (m.text LIKE ? OR CAST(m.attributedBody AS TEXT) LIKE ? OR h.id LIKE ? OR c.display_name LIKE ? ${handleClause}) AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ORDER BY m.date DESC LIMIT ?`).all(pat, pat, pat, pat, limit);
  db.close();
  const text = msgs.map(msg => { const from = msg.is_from_me ? 'You' : resolveHandleToName(msg.contact); const chatInfo = msg.chat_name ? ` (${msg.chat_name})` : ''; const t = getMessageText(msg) || ''; const att = msg.cache_has_attachments ? ' \u{1F4CE}' : ''; return `[${msg.date}] ${from}${chatInfo}: ${t}${att}`; }).filter(l => !l.endsWith(': ')).join('\n\n');
  return { content: [{ type: 'text', text: text || `No messages found matching "${query}".` }] };
}

async function getConversation({ contact, limit = 100, hours_ago = null }) {
  const db = openDatabase();
  let chats = [];
  if (!contact.includes('@') && !contact.includes('+') && !/^\d{7,}$/.test(contact)) {
    const normalizedIds = resolveNameToHandleIds(contact);
    if (normalizedIds.length > 0) {
      const allHandles = db.prepare('SELECT ROWID,id FROM handle').all();
      const matchingRowIds = allHandles.filter(h => { const hn = h.id.includes('@') ? h.id.toLowerCase().trim() : normalizePhoneNumber(h.id); return hn && normalizedIds.includes(hn); }).map(h => h.ROWID);
      if (matchingRowIds.length > 0) chats = db.prepare(`SELECT DISTINCT c.ROWID as chat_id,h.id as handle FROM chat c JOIN chat_handle_join chj ON c.ROWID=chj.chat_id JOIN handle h ON chj.handle_id=h.ROWID WHERE h.ROWID IN (${matchingRowIds.map(() => '?').join(',')})`).all(...matchingRowIds);
    }
    if (chats.length === 0) chats = db.prepare('SELECT DISTINCT c.ROWID as chat_id,h.id as handle FROM chat c JOIN chat_handle_join chj ON c.ROWID=chj.chat_id JOIN handle h ON chj.handle_id=h.ROWID WHERE c.display_name LIKE ? OR h.id LIKE ?').all(`%${contact}%`, `%${contact}%`);
  } else {
    chats = db.prepare('SELECT DISTINCT c.ROWID as chat_id,h.id as handle FROM chat c JOIN chat_handle_join chj ON c.ROWID=chj.chat_id JOIN handle h ON chj.handle_id=h.ROWID WHERE h.id LIKE ?').all(`%${contact}%`);
  }
  if (chats.length === 0) { db.close(); return { content: [{ type: 'text', text: `No conversation found with "${contact}".` }] }; }
  const chatIds = chats.map(c => c.chat_id).join(',');
  let dateFilter = '';
  if (hours_ago) dateFilter = `AND m.date > (strftime('%s','now') - ${hours_ago * 3600} - strftime('%s','2001-01-01')) * 1000000000`;
  const msgs = db.prepare(`SELECT m.ROWID,m.text,m.attributedBody,m.is_from_me,m.cache_has_attachments,datetime(m.date/1000000000+strftime('%s','2001-01-01'),'unixepoch','localtime') as date,h.id as contact FROM message m LEFT JOIN handle h ON m.handle_id=h.ROWID JOIN chat_message_join cmj ON m.ROWID=cmj.message_id WHERE cmj.chat_id IN (${chatIds}) AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${dateFilter} ORDER BY m.date DESC LIMIT ?`).all(limit);
  const messageIds = msgs.filter(m => m.cache_has_attachments).map(m => m.ROWID);
  let attMap = {};
  if (messageIds.length > 0) { for (const a of db.prepare(`SELECT maj.message_id,a.ROWID as attachment_id,a.filename,a.mime_type,a.transfer_name FROM message_attachment_join maj JOIN attachment a ON maj.attachment_id=a.ROWID WHERE maj.message_id IN (${messageIds.join(',')})`).all()) { if (!attMap[a.message_id]) attMap[a.message_id] = []; attMap[a.message_id].push(a); } }
  db.close();
  const text = msgs.reverse().map(msg => {
    const from = msg.is_from_me ? 'You' : resolveHandleToName(msg.contact || contact);
    const t = getMessageText(msg) || '';
    let attInfo = '';
    if (attMap[msg.ROWID]) { attInfo = ' ' + attMap[msg.ROWID].map(a => { const n = a.transfer_name || path.basename(a.filename || 'file'); const m = a.mime_type || ''; if (m.startsWith('image/')) return `[image: ${n}]`; if (m.startsWith('video/')) return `[video: ${n}]`; return `[file: ${n}]`; }).join(' '); }
    return `[${msg.date}] ${from} (ID: ${msg.ROWID}): ${t}${attInfo}`;
  }).filter(l => { const m = l.match(/\(ID: \d+\): (.*)$/); return m && m[1].trim().length > 0; }).join('\n\n');
  const timeInfo = hours_ago ? ` (last ${hours_ago} hours)` : '';
  return { content: [{ type: 'text', text: text || `No messages found with "${contact}"${timeInfo}.` }] };
}

async function sendMessage({ to, message, confirm, service = 'auto' }) {
  if (!to.includes('@') && !to.includes('+') && !/^\d{7,}$/.test(to)) {
    const resolved = resolveNameToHandleIds(to);
    if (resolved.length > 0) { const db = openDatabase(); const allHandles = db.prepare('SELECT id FROM handle').all(); db.close(); for (const h of allHandles) { const hn = h.id.includes('@') ? h.id.toLowerCase().trim() : normalizePhoneNumber(h.id); if (hn && resolved.includes(hn)) { to = h.id; break; } } }
  }
  if (!confirm) { return { content: [{ type: 'text', text: `Message NOT sent. Confirmation required.\n\nTo: ${to}\nMessage: "${message}"\n\nSet confirm=true to send.` }] }; }
  const st = to.replace(/["'\\]/g, ''); const sm = message.replace(/"/g, '\\"');
  const runScript = (script) => execSync(`osascript -e '${script.replace(/'/g, "'\\''")}' `);
  const buildScript = (svc) => `tell application "Messages"\nset targetService to 1st account whose service type = ${svc}\nset targetBuddy to participant "${st}" of targetService\nsend "${sm}" to targetBuddy\nend tell`;
  if (service === 'imessage') { runScript(buildScript('iMessage')); return { content: [{ type: 'text', text: `iMessage sent to ${to}` }] }; }
  if (service === 'sms') { runScript(buildScript('SMS')); return { content: [{ type: 'text', text: `SMS sent to ${to}` }] }; }
  try { runScript(buildScript('iMessage')); return { content: [{ type: 'text', text: `iMessage sent to ${to}` }] }; }
  catch { runScript(buildScript('SMS')); return { content: [{ type: 'text', text: `SMS sent to ${to} (as SMS)` }] }; }
}

async function listRecentChats({ limit = 20, hours_ago = null }) {
  const db = openDatabase();
  let dateFilter = hours_ago ? `WHERE m.date > (strftime('%s','now') - ${hours_ago * 3600} - strftime('%s','2001-01-01')) * 1000000000` : '';
  const chats = db.prepare(`SELECT c.ROWID as chat_id,c.chat_identifier,c.display_name,MAX(datetime(m.date/1000000000+strftime('%s','2001-01-01'),'unixepoch','localtime')) as last_message_date,COUNT(m.ROWID) as message_count,h.id as handle FROM chat c JOIN chat_message_join cmj ON c.ROWID=cmj.chat_id JOIN message m ON cmj.message_id=m.ROWID LEFT JOIN chat_handle_join chj ON c.ROWID=chj.chat_id LEFT JOIN handle h ON chj.handle_id=h.ROWID ${dateFilter} GROUP BY c.ROWID ORDER BY MAX(m.date) DESC LIMIT ?`).all(limit);
  db.close();
  const text = chats.map((c, i) => { const name = c.display_name || (c.handle ? resolveHandleToName(c.handle) : null) || c.chat_identifier; return `${i+1}. ${name}\n   Last: ${c.last_message_date} | Messages: ${c.message_count}`; }).join('\n\n');
  return { content: [{ type: 'text', text: `Recent Conversations:\n\n${text}` }] };
}

async function lookupContact({ name }) {
  ensureContactCache();
  const results = []; const seen = new Set();
  for (const dbPath of getAddressBookPaths()) {
    let db; try { db = new Database(dbPath, { readonly: true, fileMustExist: true }); } catch { continue; }
    try {
      const pat = `%${name.toLowerCase()}%`;
      for (const c of db.prepare('SELECT DISTINCT r.Z_PK,r.ZFIRSTNAME,r.ZLASTNAME,r.ZORGANIZATION,r.ZNICKNAME FROM ZABCDRECORD r WHERE (LOWER(r.ZFIRSTNAME) LIKE ? OR LOWER(r.ZLASTNAME) LIKE ? OR LOWER(r.ZORGANIZATION) LIKE ? OR LOWER(COALESCE(r.ZFIRSTNAME,\'\') || \' \' || COALESCE(r.ZLASTNAME,\'\')) LIKE ?)').all(pat, pat, pat, pat)) {
        const dn = buildDisplayName(c); if (!dn || seen.has(dn.toLowerCase())) continue; seen.add(dn.toLowerCase());
        const phones = db.prepare('SELECT ZFULLNUMBER FROM ZABCDPHONENUMBER WHERE ZOWNER=?').all(c.Z_PK);
        const emails = db.prepare('SELECT ZADDRESS FROM ZABCDEMAILADDRESS WHERE ZOWNER=?').all(c.Z_PK);
        results.push({ name: dn, phones, emails });
      }
    } catch { } finally { db.close(); }
  }
  if (results.length === 0) return { content: [{ type: 'text', text: `No contacts found matching "${name}".` }] };
  const text = results.map((c, i) => `${i+1}. ${c.name}${c.phones.length ? '\n   Phones: ' + c.phones.map(p => p.ZFULLNUMBER).join(', ') : ''}${c.emails.length ? '\n   Emails: ' + c.emails.map(e => e.ZADDRESS).join(', ') : ''}`).join('\n\n');
  return { content: [{ type: 'text', text: `Found ${results.length} contact(s):\n\n${text}` }] };
}

async function reactToMessage({ message_id, reaction, confirm }) {
  const reactionMap = { love: '0', like: '1', dislike: '2', laugh: '3', emphasize: '4', question: '5' };
  const emoji = { love: '\u2764\uFE0F', like: '\uD83D\uDC4D', dislike: '\uD83D\uDC4E', laugh: '\uD83D\uDE02', emphasize: '\u203C\uFE0F', question: '\u2753' };
  if (!confirm) return { content: [{ type: 'text', text: `Reaction NOT sent. Set confirm=true to send ${emoji[reaction]} to message ${message_id}.` }] };
  const script = `tell application "Messages"\nset targetMessage to a reference to message id ${message_id}\nadd reaction ${reactionMap[reaction]} to targetMessage\nend tell`;
  execSync(`osascript -e '${script.replace(/'/g, "'\\''")}' `);
  return { content: [{ type: 'text', text: `Reaction sent: ${emoji[reaction]} to message ${message_id}` }] };
}

async function getAttachment({ message_id }) {
  const db = openDatabase();
  const atts = db.prepare('SELECT a.ROWID as attachment_id,a.filename,a.mime_type,a.transfer_name,a.total_bytes FROM message_attachment_join maj JOIN attachment a ON maj.attachment_id=a.ROWID WHERE maj.message_id=?').all(message_id);
  db.close();
  if (atts.length === 0) return { content: [{ type: 'text', text: `No attachments found for message ID ${message_id}.` }] };
  const blocks = [];
  for (const att of atts) {
    const filePath = resolveAttachmentPath(att.filename);
    const name = att.transfer_name || path.basename(att.filename || 'file');
    const mime = att.mime_type || getMimeType(name);
    if (!filePath || !fs.existsSync(filePath)) { blocks.push({ type: 'text', text: `${name} - file not found` }); continue; }
    if (mime.startsWith('image/') && !mime.includes('heic') && !mime.includes('heif')) {
      const data = fs.readFileSync(filePath);
      blocks.push({ type: 'image', data: data.toString('base64'), mimeType: mime });
      blocks.push({ type: 'text', text: `${name} (${att.total_bytes} bytes)` });
    } else if (mime.includes('heic') || mime.includes('heif')) {
      const tmpPath = `/tmp/imessage_${att.attachment_id}.jpg`;
      try { execSync(`sips -s format jpeg "${filePath}" --out "${tmpPath}" 2>/dev/null`); const data = fs.readFileSync(tmpPath); blocks.push({ type: 'image', data: data.toString('base64'), mimeType: 'image/jpeg' }); blocks.push({ type: 'text', text: `${name} (converted from HEIC)` }); try { fs.unlinkSync(tmpPath); } catch {} }
      catch (e) { blocks.push({ type: 'text', text: `${name} (HEIC) - conversion failed: ${e.message}` }); }
    } else {
      blocks.push({ type: 'text', text: `${name} (${mime}, ${att.total_bytes} bytes)` });
    }
  }
  return { content: blocks };
}

function createServer() {
  const server = new McpServer({ name: 'imessage-server', version: VERSION }, { capabilities: { logging: {} } });
  server.registerTool('read_recent_messages', { title: 'Read Recent Messages', description: 'Read recent iMessages from your Messages app', inputSchema: { limit: z.number().int().min(1).max(500).optional(), include_group_chats: z.boolean().optional() } }, async (args) => { try { return await readRecentMessages(args); } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; } });
  server.registerTool('search_messages', { title: 'Search Messages', description: 'Search for messages by contact name, phone number, or message content', inputSchema: { query: z.string(), limit: z.number().int().optional() } }, async (args) => { try { return await searchMessages(args); } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; } });
  server.registerTool('get_conversation', { title: 'Get Conversation', description: 'Get full conversation thread with a specific contact', inputSchema: { contact: z.string(), limit: z.number().int().optional(), hours_ago: z.number().optional() } }, async (args) => { try { return await getConversation(args); } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; } });
  server.registerTool('send_message', { title: 'Send Message', description: 'Send an iMessage or SMS. Always confirm before sending.', inputSchema: { to: z.string(), message: z.string(), confirm: z.boolean(), service: z.enum(['auto', 'imessage', 'sms']).optional() } }, async (args) => { try { return await sendMessage(args); } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; } });
  server.registerTool('list_recent_chats', { title: 'List Recent Chats', description: 'List recent active conversations', inputSchema: { limit: z.number().int().optional(), hours_ago: z.number().optional() } }, async (args) => { try { return await listRecentChats(args); } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; } });
  server.registerTool('lookup_contact', { title: 'Lookup Contact', description: 'Look up a contact name in macOS Contacts', inputSchema: { name: z.string() } }, async (args) => { try { return await lookupContact(args); } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; } });
  server.registerTool('react_to_message', { title: 'React to Message', description: 'React to a message with an emoji. Always confirm before sending.', inputSchema: { message_id: z.string(), reaction: z.enum(['love', 'like', 'dislike', 'laugh', 'emphasize', 'question']), confirm: z.boolean() } }, async (args) => { try { return await reactToMessage(args); } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; } });
  server.registerTool('get_attachment', { title: 'Get Attachment', description: 'Get an attachment from a message', inputSchema: { message_id: z.string() } }, async (args) => { try { return await getAttachment(args); } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; } });
  return server;
}

function requireBearer(req, res, next) {
  if (req.headers.authorization !== `Bearer ${MCP_API_KEY}`) { return res.status(401).json({ error: 'Unauthorized' }); }
  next();
}

const app = express();
const transports = new Map();
app.use(express.json({ limit: '10mb' }));
app.get('/healthz', (_req, res) => res.json({ ok: true, name: 'imessage-mcp', version: VERSION }));
app.use('/mcp', requireBearer);
app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && transports.has(sessionId)) { await transports.get(sessionId).handleRequest(req, res, req.body); return; }
  if (!sessionId && isInitializeRequest(req.body)) {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => { transports.set(id, transport); } });
    transport.onclose = () => { if (transport.sessionId) transports.delete(transport.sessionId); };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }
  res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Invalid session' }, id: null });
});
app.get('/mcp', async (req, res) => { const s = req.headers['mcp-session-id']; if (s && transports.has(s)) { await transports.get(s).handleRequest(req, res); return; } res.status(400).send('Invalid session'); });
app.delete('/mcp', async (req, res) => { const s = req.headers['mcp-session-id']; if (s && transports.has(s)) { await transports.get(s).handleRequest(req, res); return; } res.status(400).send('Invalid session'); });
app.listen(PORT, HOST, () => { console.log(`imessage-mcp HTTP server listening on ${HOST}:${PORT}/mcp`); });