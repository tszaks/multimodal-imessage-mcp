#!/usr/bin/env node

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_MAX_BATCH_SIZE, createApprovalToken, validateBatch } = require('./lib/batch');
const { classifyConversation, normalizeText } = require('./lib/outreach');

// Path to iMessage database
const DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const SERVER_VERSION = '1.4.2';
const RELEASE_AUTO_SMS_FALLBACK = 'auto_sms_fallback';
const RELEASE_CLEANUP_FAILED_IMESSAGE = 'cleanup_failed_imessage_after_sms_fallback';
const DEFAULT_SEND_VERIFY_DELAY_MS = 2500;

class IMessageServer {
  constructor(options = {}) {
    this.server = new Server(
      {
        name: 'imessage-server',
        version: SERVER_VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    this.runScript = options.runScript || ((script) => execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`));
    this.releaseFlags = new Set((process.env.IMESSAGE_MCP_RELEASES || '')
      .split(',')
      .map(flag => flag.trim())
      .filter(Boolean));

    // Contact cache — lazy loaded on first use
    this._contactCache = null;
    this._nameToHandles = null;
    this._cacheInitialized = false;

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  /**
   * Extract plain text from iMessage's attributedBody binary blob.
   * macOS stores most messages in NSAttributedString format (binary plist)
   * rather than the legacy `text` column. The text is embedded after the
   * "NSString" marker with a length prefix.
   */
  extractTextFromAttributedBody(buf) {
    if (!Buffer.isBuffer(buf)) return null;

    const marker = Buffer.from('NSString');
    const idx = buf.indexOf(marker);
    if (idx === -1) return null;

    // Pattern: NSString + [01 94 84 01] + 2b + length + text
    let pos = idx + marker.length;

    // Find the 0x2b ('+') byte that precedes the length
    const searchEnd = Math.min(pos + 12, buf.length);
    while (pos < searchEnd) {
      if (buf[pos] === 0x2b) break;
      pos++;
    }
    if (pos >= buf.length || buf[pos] !== 0x2b) return null;
    pos++;

    // Read length. Apple stores the extended length bytes little-endian here.
    if (pos >= buf.length) return null;
    let textLen = buf[pos];
    pos++;

    if (textLen === 0x81 && pos + 2 <= buf.length) {
      textLen = buf.readUInt16LE(pos);
      pos += 2;
    } else if (textLen === 0x82 && pos + 4 <= buf.length) {
      textLen = buf.readUInt32LE(pos);
      pos += 4;
    }

    if (textLen <= 0 || pos + textLen > buf.length) return null;

    return buf.slice(pos, pos + textLen).toString('utf-8');
  }

  /**
   * Get message text from either the `text` column or `attributedBody` blob.
   */
  getMessageText(msg) {
    if (msg.text) return msg.text;
    if (msg.attributedBody) return this.extractTextFromAttributedBody(msg.attributedBody);
    return null;
  }

  /**
   * Resolve attachment path — iMessage uses ~/Library/Messages/ relative paths
   * prefixed with "~/" that need expanding.
   */
  resolveAttachmentPath(filename) {
    if (!filename) return null;
    if (filename.startsWith('~')) {
      return path.join(os.homedir(), filename.slice(1));
    }
    return filename;
  }

  /**
   * Get MIME type from file extension.
   */
  getMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const mimeMap = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.png': 'image/png', '.gif': 'image/gif',
      '.heic': 'image/heic', '.heif': 'image/heif',
      '.webp': 'image/webp', '.tiff': 'image/tiff',
      '.bmp': 'image/bmp', '.pdf': 'application/pdf',
      '.mov': 'video/quicktime', '.mp4': 'video/mp4',
      '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
      '.caf': 'audio/x-caf',
    };
    return mimeMap[ext] || 'application/octet-stream';
  }

  jsonResponse(data) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  }

  getChatHandles(db, chatId) {
    const rows = db.prepare(`
      SELECT h.ROWID as handle_rowid, h.id as handle
      FROM chat_handle_join chj
      JOIN handle h ON chj.handle_id = h.ROWID
      WHERE chj.chat_id = ?
      ORDER BY h.id
    `).all(chatId);

    return rows.map(row => ({
      handle_rowid: row.handle_rowid,
      handle: row.handle,
      display_name: this.resolveHandleToName(row.handle),
    }));
  }

  getAttachmentMap(db, messageIds) {
    if (!messageIds.length) return {};
    const placeholders = messageIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT
        maj.message_id,
        a.ROWID as attachment_id,
        a.filename,
        a.mime_type,
        a.transfer_name,
        a.total_bytes
      FROM message_attachment_join maj
      JOIN attachment a ON maj.attachment_id = a.ROWID
      WHERE maj.message_id IN (${placeholders})
    `).all(...messageIds);

    const attachmentMap = {};
    for (const row of rows) {
      if (!attachmentMap[row.message_id]) attachmentMap[row.message_id] = [];
      attachmentMap[row.message_id].push({
        attachment_id: row.attachment_id,
        filename: row.filename,
        mime_type: row.mime_type,
        transfer_name: row.transfer_name,
        total_bytes: row.total_bytes,
      });
    }
    return attachmentMap;
  }

  hydrateMessage(row, attachmentMap = {}) {
    const handle = row.contact || row.handle || null;
    const attachments = attachmentMap[row.ROWID] || [];
    return {
      message_id: String(row.ROWID),
      date: row.date,
      from_me: Boolean(row.is_from_me),
      handle,
      display_name: row.is_from_me ? 'You' : this.resolveHandleToName(handle),
      decoded_text: this.getMessageText(row) || '',
      has_attachments: Boolean(row.cache_has_attachments),
      attachments,
    };
  }

  getLastMessageForChat(db, chatId) {
    const row = db.prepare(`
      SELECT
        m.ROWID,
        m.text,
        m.attributedBody,
        m.is_from_me,
        m.cache_has_attachments,
        datetime(m.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') as date,
        h.id as contact
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
      WHERE cmj.chat_id = ?
      AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL OR m.cache_has_attachments = 1)
      ORDER BY m.date DESC
      LIMIT 1
    `).get(chatId);
    return row ? this.hydrateMessage(row) : null;
  }

  getChatDisplayName(row, handles) {
    if (row.display_name) return row.display_name;
    if (handles.length === 1) return handles[0].display_name || handles[0].handle;
    if (handles.length > 1) return handles.map(handle => handle.display_name || handle.handle).join(', ');
    return row.chat_identifier || `chat:${row.chat_id}`;
  }

  fetchChatSummaries(db, options = {}) {
    const limit = options.limit || 20;
    const hoursAgo = options.hours_ago || null;
    const params = [];
    let dateFilter = '';

    if (hoursAgo) {
      params.push(hoursAgo * 3600);
      dateFilter = `WHERE m.date > (strftime('%s', 'now') - ? - strftime('%s', '2001-01-01')) * 1000000000`;
    }

    params.push(limit);
    const rows = db.prepare(`
      SELECT
        c.ROWID as chat_id,
        c.chat_identifier,
        c.display_name,
        MAX(datetime(m.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime')) as last_message_date,
        COUNT(DISTINCT m.ROWID) as message_count
      FROM chat c
      JOIN chat_message_join cmj ON c.ROWID = cmj.chat_id
      JOIN message m ON cmj.message_id = m.ROWID
      ${dateFilter}
      GROUP BY c.ROWID
      ORDER BY MAX(m.date) DESC
      LIMIT ?
    `).all(...params);

    return rows.map(row => {
      const handles = this.getChatHandles(db, row.chat_id);
      const lastMessage = this.getLastMessageForChat(db, row.chat_id);
      const isGroup = handles.length > 1 || String(row.chat_identifier || '').includes('chat');
      return {
        chat_id: row.chat_id,
        chat_identifier: row.chat_identifier,
        display_name: this.getChatDisplayName(row, handles),
        handles,
        is_group: isGroup,
        last_message_date: row.last_message_date,
        message_count: row.message_count,
        last_message: lastMessage ? {
          message_id: lastMessage.message_id,
          date: lastMessage.date,
          from_me: lastMessage.from_me,
          handle: lastMessage.handle,
          display_name: lastMessage.display_name,
          text_preview: normalizeText(lastMessage.decoded_text).slice(0, 240),
          has_attachments: lastMessage.has_attachments,
        } : null,
      };
    });
  }

  fetchConversationDataByChatId(db, chatId, options = {}) {
    const limit = options.limit || 100;
    const hoursAgo = options.hours_ago || null;
    const chat = db.prepare(`
      SELECT ROWID as chat_id, chat_identifier, display_name
      FROM chat
      WHERE ROWID = ?
    `).get(chatId);

    if (!chat) return null;

    const handles = this.getChatHandles(db, chatId);
    const params = [chatId];
    let dateFilter = '';
    if (hoursAgo) {
      params.push(hoursAgo * 3600);
      dateFilter = `AND m.date > (strftime('%s', 'now') - ? - strftime('%s', '2001-01-01')) * 1000000000`;
    }
    params.push(limit);

    const rows = db.prepare(`
      SELECT
        m.ROWID,
        m.text,
        m.attributedBody,
        m.is_from_me,
        m.cache_has_attachments,
        datetime(m.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') as date,
        h.id as contact
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
      WHERE cmj.chat_id = ?
      AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL OR m.cache_has_attachments = 1)
      ${dateFilter}
      ORDER BY m.date DESC
      LIMIT ?
    `).all(...params);

    const orderedRows = rows.reverse();
    const attachmentMap = this.getAttachmentMap(
      db,
      orderedRows.filter(row => row.cache_has_attachments).map(row => row.ROWID)
    );
    const messages = orderedRows
      .map(row => this.hydrateMessage(row, attachmentMap))
      .filter(message => message.decoded_text.trim().length > 0 || message.attachments.length > 0);
    const isGroup = handles.length > 1 || String(chat.chat_identifier || '').includes('chat');

    return {
      chat_id: chat.chat_id,
      chat_identifier: chat.chat_identifier,
      display_name: this.getChatDisplayName(chat, handles),
      handles,
      is_group: isGroup,
      messages,
    };
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'read_recent_messages',
          description: 'Read recent iMessages from your Messages app',
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: 'Number of recent messages to retrieve (default: 50)',
                default: 50,
              },
              include_group_chats: {
                type: 'boolean',
                description: 'Include group chat messages (default: true)',
                default: true,
              },
            },
          },
        },
        {
          name: 'search_messages',
          description: 'Search for messages by contact name, phone number, or message content',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query (contact name, phone, or message text)',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results (default: 25)',
                default: 25,
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_conversation',
          description: 'Get full conversation thread with a specific contact or phone number, optionally filtered by time. Shows text content and indicates attachments.',
          inputSchema: {
            type: 'object',
            properties: {
              contact: {
                type: 'string',
                description: 'Contact name or phone number',
              },
              phone_number: {
                type: 'string',
                description: 'Phone number alias for contact. Kept for compatibility with clients that call this tool using phone_number.',
              },
              limit: {
                type: 'number',
                description: 'Number of messages to retrieve (default: 100)',
                default: 100,
              },
              hours_ago: {
                type: 'number',
                description: 'Optional: Only show messages from the last N hours (e.g., 12 for last 12 hours, 24 for last day)',
              },
            },
          },
        },
        {
          name: 'list_chats_structured',
          description: 'List recent chats as structured JSON with chat IDs, handles, last sender, last message preview, group status, and message counts.',
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: 'Number of conversations to return (default: 20)',
                default: 20,
              },
              hours_ago: {
                type: 'number',
                description: 'Only show chats active in the last N hours (optional)',
              },
            },
          },
        },
        {
          name: 'get_conversation_by_chat_id',
          description: 'Get a conversation by iMessage chat_id as structured JSON. Use chat_id from list_chats_structured or find_outreach_followups.',
          inputSchema: {
            type: 'object',
            properties: {
              chat_id: {
                type: 'number',
                description: 'The iMessage chat ROWID.',
              },
              limit: {
                type: 'number',
                description: 'Number of messages to retrieve (default: 100)',
                default: 100,
              },
              hours_ago: {
                type: 'number',
                description: 'Optional: Only show messages from the last N hours.',
              },
            },
            required: ['chat_id'],
          },
        },
        {
          name: 'find_outreach_followups',
          description: 'Find SMS outreach conversations that need agent review or follow-up. Returns structured candidates with status, risk labels, and evidence snippets.',
          inputSchema: {
            type: 'object',
            properties: {
              hours_ago: {
                type: 'number',
                description: 'Look for outreach in the last N hours (default: 168).',
                default: 168,
              },
              limit: {
                type: 'number',
                description: 'Number of recent chats to inspect (default: 100).',
                default: 100,
              },
              max_results: {
                type: 'number',
                description: 'Maximum classified results to return (default: 50).',
                default: 50,
              },
              outreach_terms: {
                type: 'array',
                description: 'Optional custom terms that mark Tyler outbound messages as site-sales outreach.',
                items: { type: 'string' },
              },
            },
          },
        },
        {
          name: 'send_message',
          description: 'Send an iMessage or SMS/RCS to a contact (uses AppleScript). Supports iMessage (blue bubble), SMS/RCS (green bubble), or auto-detection with verified fallback when the auto_sms_fallback release flag is enabled. IMPORTANT: Always show the user the message content and recipient before sending, and get explicit confirmation.',
          inputSchema: {
            type: 'object',
            properties: {
              to: {
                type: 'string',
                description: 'Phone number or email address (e.g., +1234567890 or email@example.com)',
              },
              message: {
                type: 'string',
                description: 'Message text to send',
              },
              service: {
                type: 'string',
                description: 'Messaging service to use: "auto" (try iMessage first, fall back to SMS), "imessage" (force iMessage/blue bubble), "sms" (force SMS/green bubble). Defaults to "auto".',
                enum: ['auto', 'imessage', 'sms'],
                default: 'auto',
              },
              confirm: {
                type: 'boolean',
                description: 'Must be set to true to actually send the message. This forces explicit confirmation.',
                default: false,
              },
            },
            required: ['to', 'message', 'confirm'],
          },
        },
        {
          name: 'detect_message_service',
          description: 'Inspect local Messages history for a recipient and recommend iMessage, SMS/RCS, or auto before sending. This is best-effort because Apple does not expose a direct preflight availability API.',
          inputSchema: {
            type: 'object',
            properties: {
              to: {
                type: 'string',
                description: 'Phone number, email address, or contact name.',
              },
              limit: {
                type: 'number',
                description: 'Number of recent matching outgoing messages to inspect (default: 20).',
                default: 20,
              },
            },
            required: ['to'],
          },
        },
        {
          name: 'send_message_batch',
          description: 'Preview or send a reviewed SMS/iMessage batch. Preview returns an approval token. Sending requires the same exact batch, confirm=true, and the token.',
          inputSchema: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                description: 'Exact messages to send.',
                items: {
                  type: 'object',
                  properties: {
                    to: { type: 'string', description: 'Phone number or email address.' },
                    message: { type: 'string', description: 'Exact message text to send.' },
                    candidate_id: { type: 'string', description: 'Optional outreach candidate ID.' },
                    risk_level: { type: 'string', description: 'Optional risk level from find_outreach_followups.' },
                    risk_labels: {
                      type: 'array',
                      description: 'Optional risk labels from find_outreach_followups.',
                      items: { type: 'string' },
                    },
                  },
                  required: ['to', 'message'],
                },
              },
              service: {
                type: 'string',
                description: 'Messaging service to use for every message. Defaults to sms.',
                enum: ['auto', 'imessage', 'sms'],
                default: 'sms',
              },
              confirm: {
                type: 'boolean',
                description: 'Set true only after reviewing the exact preview and approval token.',
                default: false,
              },
              approval_token: {
                type: 'string',
                description: 'Approval token returned by the preview call.',
              },
            },
            required: ['items'],
          },
        },
        {
          name: 'list_delivery_failures',
          description: 'List recent outgoing messages that Messages marked failed, pending, or potentially recovered by SMS/RCS fallback. Use this to find red Not Delivered bubbles.',
          inputSchema: {
            type: 'object',
            properties: {
              hours_ago: {
                type: 'number',
                description: 'Look back this many hours (default: 24).',
                default: 24,
              },
              limit: {
                type: 'number',
                description: 'Maximum delivery issues to return (default: 50).',
                default: 50,
              },
              include_pending: {
                type: 'boolean',
                description: 'Include rows where Messages has not marked sent yet but error is 0 (default: true).',
                default: true,
              },
            },
          },
        },
        {
          name: 'list_recent_chats',
          description: 'List recent active conversations, sorted by most recent activity',
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: 'Number of conversations to return (default: 20)',
                default: 20,
              },
              hours_ago: {
                type: 'number',
                description: 'Only show chats active in the last N hours (optional)',
              },
            },
          },
        },
        {
          name: 'lookup_contact',
          description: 'Look up a contact name in macOS Contacts to find their phone number or email',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Contact name to search for (e.g., "Mom", "Luisa", "John Smith")',
              },
            },
            required: ['name'],
          },
        },
        {
          name: 'react_to_message',
          description: 'React to a message with an emoji (❤️, 👍, 👎, 😂, ‼️, ❓). IMPORTANT: Always show the user which message and reaction before sending, and get explicit confirmation.',
          inputSchema: {
            type: 'object',
            properties: {
              message_id: {
                type: 'string',
                description: 'The message ID to react to (from conversation results)',
              },
              reaction: {
                type: 'string',
                description: 'Reaction emoji: love (❤️), like (👍), dislike (👎), laugh (😂), emphasize (‼️), question (❓)',
                enum: ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question'],
              },
              confirm: {
                type: 'boolean',
                description: 'Must be set to true to actually send the reaction. This forces explicit confirmation.',
                default: false,
              },
            },
            required: ['message_id', 'reaction', 'confirm'],
          },
        },
        {
          name: 'get_attachment',
          description: 'Get an attachment (image, file) from a message. Returns images directly so Claude can view and analyze them. Use message IDs from get_conversation results.',
          inputSchema: {
            type: 'object',
            properties: {
              message_id: {
                type: 'string',
                description: 'The message ROWID to get attachments for (from conversation results)',
              },
            },
            required: ['message_id'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          case 'read_recent_messages':
            return await this.readRecentMessages(request.params.arguments);
          case 'search_messages':
            return await this.searchMessages(request.params.arguments);
          case 'get_conversation':
            return await this.getConversation(request.params.arguments);
          case 'list_chats_structured':
            return await this.listChatsStructured(request.params.arguments);
          case 'get_conversation_by_chat_id':
            return await this.getConversationByChatId(request.params.arguments);
          case 'find_outreach_followups':
            return await this.findOutreachFollowups(request.params.arguments);
          case 'send_message':
            return await this.sendMessage(request.params.arguments);
          case 'detect_message_service':
            return await this.detectMessageService(request.params.arguments);
          case 'send_message_batch':
            return await this.sendMessageBatch(request.params.arguments);
          case 'list_delivery_failures':
            return await this.listDeliveryFailures(request.params.arguments);
          case 'list_recent_chats':
            return await this.listRecentChats(request.params.arguments);
          case 'lookup_contact':
            return await this.lookupContact(request.params.arguments);
          case 'react_to_message':
            return await this.reactToMessage(request.params.arguments);
          case 'get_attachment':
            return await this.getAttachment(request.params.arguments);
          default:
            throw new Error(`Unknown tool: ${request.params.name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  openDatabase() {
    try {
      return new Database(DB_PATH, { readonly: true });
    } catch (error) {
      throw new Error(`Failed to open iMessage database: ${error.message}. Make sure you've granted Full Disk Access to Terminal/Claude Code.`);
    }
  }

  // ──────────────────────────────────────────────────────────
  // Contact Cache — reads macOS AddressBook SQLite directly
  // ──────────────────────────────────────────────────────────

  normalizePhoneNumber(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 7) return null;
    if (digits.length === 11 && digits.startsWith('1')) {
      return digits.slice(1);
    }
    return digits;
  }

  getAddressBookPaths() {
    const abRoot = path.join(os.homedir(), 'Library', 'Application Support', 'AddressBook', 'Sources');
    if (!fs.existsSync(abRoot)) return [];
    const sources = [];
    try {
      const dirs = fs.readdirSync(abRoot);
      for (const dir of dirs) {
        const dbPath = path.join(abRoot, dir, 'AddressBook-v22.abcddb');
        if (fs.existsSync(dbPath)) {
          sources.push(dbPath);
        }
      }
    } catch (err) {
      console.error('[Contact Cache] Failed to scan AddressBook sources:', err.message);
    }
    return sources;
  }

  buildDisplayName(row) {
    const first = (row.ZFIRSTNAME || '').trim();
    const last = (row.ZLASTNAME || '').trim();
    const org = (row.ZORGANIZATION || '').trim();
    const nick = (row.ZNICKNAME || '').trim();
    if (first && last) return `${first} ${last}`;
    if (first) return first;
    if (nick) return nick;
    if (last) return last;
    if (org) return org;
    return null;
  }

  indexContactName(nameToHandles, displayName, normalizedId, row) {
    const lowerDisplay = displayName.toLowerCase();
    if (!nameToHandles.has(lowerDisplay)) nameToHandles.set(lowerDisplay, new Set());
    nameToHandles.get(lowerDisplay).add(normalizedId);

    const first = (row.ZFIRSTNAME || '').trim().toLowerCase();
    if (first) {
      if (!nameToHandles.has(first)) nameToHandles.set(first, new Set());
      nameToHandles.get(first).add(normalizedId);
    }

    const nick = (row.ZNICKNAME || '').trim().toLowerCase();
    if (nick) {
      if (!nameToHandles.has(nick)) nameToHandles.set(nick, new Set());
      nameToHandles.get(nick).add(normalizedId);
    }

    const org = (row.ZORGANIZATION || '').trim().toLowerCase();
    if (org) {
      if (!nameToHandles.has(org)) nameToHandles.set(org, new Set());
      nameToHandles.get(org).add(normalizedId);
    }
  }

  buildContactCache() {
    const handleToContact = new Map();
    const nameToHandles = new Map();
    const dbPaths = this.getAddressBookPaths();

    if (dbPaths.length === 0) {
      console.error('[Contact Cache] No AddressBook databases found');
      return { handleToContact, nameToHandles };
    }

    for (const dbPath of dbPaths) {
      let db;
      try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
      } catch (err) {
        console.error(`[Contact Cache] Cannot open ${dbPath}: ${err.message}`);
        continue;
      }

      try {
        const phoneRows = db.prepare(`
          SELECT r.Z_PK, r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, r.ZNICKNAME,
                 p.ZFULLNUMBER
          FROM ZABCDRECORD r
          JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
          WHERE (r.ZFIRSTNAME IS NOT NULL OR r.ZLASTNAME IS NOT NULL OR r.ZORGANIZATION IS NOT NULL)
        `).all();

        for (const row of phoneRows) {
          const normalized = this.normalizePhoneNumber(row.ZFULLNUMBER);
          if (!normalized) continue;
          const displayName = this.buildDisplayName(row);
          if (!displayName) continue;
          handleToContact.set(normalized, {
            displayName,
            firstName: row.ZFIRSTNAME || '',
            lastName: row.ZLASTNAME || '',
            organization: row.ZORGANIZATION || '',
            nickname: row.ZNICKNAME || '',
          });
          this.indexContactName(nameToHandles, displayName, normalized, row);
        }

        const emailRows = db.prepare(`
          SELECT r.Z_PK, r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, r.ZNICKNAME,
                 e.ZADDRESS
          FROM ZABCDRECORD r
          JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK
          WHERE (r.ZFIRSTNAME IS NOT NULL OR r.ZLASTNAME IS NOT NULL OR r.ZORGANIZATION IS NOT NULL)
        `).all();

        for (const row of emailRows) {
          if (!row.ZADDRESS) continue;
          const normalizedEmail = row.ZADDRESS.toLowerCase().trim();
          const displayName = this.buildDisplayName(row);
          if (!displayName) continue;
          handleToContact.set(normalizedEmail, {
            displayName,
            firstName: row.ZFIRSTNAME || '',
            lastName: row.ZLASTNAME || '',
            organization: row.ZORGANIZATION || '',
            nickname: row.ZNICKNAME || '',
          });
          this.indexContactName(nameToHandles, displayName, normalizedEmail, row);
        }
      } catch (err) {
        console.error(`[Contact Cache] Error querying ${dbPath}: ${err.message}`);
      } finally {
        db.close();
      }
    }

    return { handleToContact, nameToHandles };
  }

  ensureContactCache() {
    if (this._cacheInitialized) return;
    try {
      const { handleToContact, nameToHandles } = this.buildContactCache();
      this._contactCache = handleToContact;
      this._nameToHandles = nameToHandles;
      console.error(`[Contact Cache] Loaded ${handleToContact.size} handle->name mappings, ${nameToHandles.size} name entries`);
    } catch (err) {
      console.error('[Contact Cache] Failed to build cache:', err.message);
      this._contactCache = new Map();
      this._nameToHandles = new Map();
    }
    this._cacheInitialized = true;
  }

  resolveHandleToName(handleId) {
    if (!handleId) return 'Unknown';
    this.ensureContactCache();
    if (handleId.includes('@')) {
      const contact = this._contactCache.get(handleId.toLowerCase().trim());
      return contact ? contact.displayName : handleId;
    }
    const normalized = this.normalizePhoneNumber(handleId);
    if (normalized) {
      const contact = this._contactCache.get(normalized);
      return contact ? contact.displayName : handleId;
    }
    return handleId;
  }

  resolveNameToHandleIds(name) {
    if (!name) return [];
    this.ensureContactCache();
    const lowerName = name.toLowerCase().trim();

    // Exact match first
    if (this._nameToHandles.has(lowerName)) {
      return Array.from(this._nameToHandles.get(lowerName));
    }

    // Substring match: find names that contain search term or vice versa
    const matches = [];
    for (const [indexedName, handleSet] of this._nameToHandles) {
      if (indexedName.includes(lowerName) || lowerName.includes(indexedName)) {
        matches.push(...handleSet);
      }
    }
    return [...new Set(matches)];
  }

  // ──────────────────────────────────────────────────────────
  // Tool Handlers
  // ──────────────────────────────────────────────────────────

  async readRecentMessages(args) {
    const limit = args.limit || 50;
    const includeGroupChats = args.include_group_chats !== false;

    const db = this.openDatabase();

    const query = `
      SELECT
        m.ROWID,
        m.text,
        m.attributedBody,
        m.is_from_me,
        m.cache_has_attachments,
        datetime(m.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') as date,
        h.id as contact,
        c.display_name as chat_name,
        c.chat_identifier
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
      LEFT JOIN chat c ON cmj.chat_id = c.ROWID
      WHERE (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
      ${includeGroupChats ? '' : "AND (c.chat_identifier IS NULL OR c.chat_identifier NOT LIKE '%chat%')"}
      ORDER BY m.date DESC
      LIMIT ?
    `;

    const messages = db.prepare(query).all(limit);
    db.close();

    const formattedMessages = messages.map(msg => {
      const from = msg.is_from_me ? 'You' : this.resolveHandleToName(msg.contact);
      const chatInfo = msg.chat_name ? ` (${msg.chat_name})` : '';
      const text = this.getMessageText(msg) || '';
      const attachment = msg.cache_has_attachments ? ' 📎' : '';
      return `[${msg.date}] ${from}${chatInfo}: ${text}${attachment}`;
    }).filter(line => !line.endsWith(': ')).join('\n\n');

    return {
      content: [
        {
          type: 'text',
          text: formattedMessages || 'No recent messages found.',
        },
      ],
    };
  }

  async searchMessages(args) {
    const query = args.query;
    const limit = args.limit || 25;

    const db = this.openDatabase();

    // Resolve query as a contact name to find associated handle IDs in chat.db
    const resolvedHandles = this.resolveNameToHandleIds(query);
    let handleClause = '';
    if (resolvedHandles.length > 0) {
      const allHandles = db.prepare('SELECT ROWID, id FROM handle').all();
      const matchingRowIds = [];
      for (const h of allHandles) {
        const hn = h.id.includes('@')
          ? h.id.toLowerCase().trim()
          : this.normalizePhoneNumber(h.id);
        if (hn && resolvedHandles.includes(hn)) {
          matchingRowIds.push(h.ROWID);
        }
      }
      if (matchingRowIds.length > 0) {
        handleClause = `OR m.handle_id IN (${matchingRowIds.join(',')})`;
      }
    }

    const searchQuery = `
      SELECT
        m.ROWID,
        m.text,
        m.attributedBody,
        m.is_from_me,
        m.cache_has_attachments,
        m.date as apple_date,
        datetime(m.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') as date,
        h.id as contact,
        c.display_name as chat_name
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
      LEFT JOIN chat c ON cmj.chat_id = c.ROWID
      WHERE (
        m.text LIKE ?
        OR CAST(m.attributedBody AS TEXT) LIKE ?
        OR h.id LIKE ?
        OR c.display_name LIKE ?
        ${handleClause}
      )
      AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
      ORDER BY m.date DESC
      LIMIT ?
    `;

    const searchPattern = `%${query}%`;
    const rowsById = new Map();
    for (const row of db.prepare(searchQuery).all(searchPattern, searchPattern, searchPattern, searchPattern, limit)) {
      rowsById.set(row.ROWID, row);
    }

    const decodedScanLimit = Math.max(1000, limit * 20);
    const decodedRows = db.prepare(`
      SELECT
        m.ROWID,
        m.text,
        m.attributedBody,
        m.is_from_me,
        m.cache_has_attachments,
        m.date as apple_date,
        datetime(m.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') as date,
        h.id as contact,
        c.display_name as chat_name
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
      LEFT JOIN chat c ON cmj.chat_id = c.ROWID
      WHERE (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
      ORDER BY m.date DESC
      LIMIT ?
    `).all(decodedScanLimit);

    const lowerQuery = query.toLowerCase();
    for (const row of decodedRows) {
      const decodedText = this.getMessageText(row) || '';
      const haystack = `${decodedText} ${row.contact || ''} ${row.chat_name || ''}`.toLowerCase();
      if (haystack.includes(lowerQuery)) {
        rowsById.set(row.ROWID, row);
      }
      if (rowsById.size >= limit) break;
    }

    const messages = Array.from(rowsById.values())
      .sort((a, b) => b.apple_date - a.apple_date)
      .slice(0, limit);
    db.close();

    const formattedMessages = messages.map(msg => {
      const from = msg.is_from_me ? 'You' : this.resolveHandleToName(msg.contact);
      const chatInfo = msg.chat_name ? ` (${msg.chat_name})` : '';
      const text = this.getMessageText(msg) || '';
      const attachment = msg.cache_has_attachments ? ' 📎' : '';
      return `[${msg.date}] ${from}${chatInfo}: ${text}${attachment}`;
    }).filter(line => !line.endsWith(': ')).join('\n\n');

    return {
      content: [
        {
          type: 'text',
          text: formattedMessages || `No messages found matching "${query}".`,
        },
      ],
    };
  }

  async getConversation(args) {
    let contact = args.contact || args.phone_number || args.phoneNumber || args.to || args.recipient;
    const limit = args.limit || 100;
    const hoursAgo = args.hours_ago || null;

    if (typeof contact !== 'string' || contact.trim().length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'Missing required contact. Pass contact or phone_number to get_conversation.',
          },
        ],
        isError: true,
      };
    }

    contact = contact.trim();

    const looksLikePhoneOrEmail = contact.includes('@') || contact.includes('+') || /^\d{7,}$/.test(contact);

    const db = this.openDatabase();
    let chats = [];

    if (!looksLikePhoneOrEmail) {
      // Resolve contact name to normalized handle IDs via cache
      const normalizedIds = this.resolveNameToHandleIds(contact);

      if (normalizedIds.length > 0) {
        // Find matching handles in chat.db
        const allHandles = db.prepare('SELECT ROWID, id FROM handle').all();
        const matchingHandleRowIds = [];
        for (const h of allHandles) {
          const hn = h.id.includes('@')
            ? h.id.toLowerCase().trim()
            : this.normalizePhoneNumber(h.id);
          if (hn && normalizedIds.includes(hn)) {
            matchingHandleRowIds.push(h.ROWID);
          }
        }

        if (matchingHandleRowIds.length > 0) {
          const placeholders = matchingHandleRowIds.map(() => '?').join(',');
          chats = db.prepare(`
            SELECT DISTINCT c.ROWID as chat_id, h.id as handle
            FROM chat c
            JOIN chat_handle_join chj ON c.ROWID = chj.chat_id
            JOIN handle h ON chj.handle_id = h.ROWID
            WHERE h.ROWID IN (${placeholders})
          `).all(...matchingHandleRowIds);
        }
      }

      // Fall back to LIKE search on display_name and handle id
      if (chats.length === 0) {
        const contactPattern = `%${contact}%`;
        chats = db.prepare(`
          SELECT DISTINCT c.ROWID as chat_id, h.id as handle
          FROM chat c
          JOIN chat_handle_join chj ON c.ROWID = chj.chat_id
          JOIN handle h ON chj.handle_id = h.ROWID
          WHERE c.display_name LIKE ? OR h.id LIKE ?
        `).all(contactPattern, contactPattern);
      }
    } else {
      // Phone/email direct search
      const contactPattern = `%${contact}%`;
      chats = db.prepare(`
        SELECT DISTINCT c.ROWID as chat_id, h.id as handle
        FROM chat c
        JOIN chat_handle_join chj ON c.ROWID = chj.chat_id
        JOIN handle h ON chj.handle_id = h.ROWID
        WHERE h.id LIKE '%' || ? || '%'
      `).all(contact);

      if (chats.length === 0) {
        chats = db.prepare(`
          SELECT DISTINCT c.ROWID as chat_id, h.id as handle
          FROM chat c
          JOIN chat_handle_join chj ON c.ROWID = chj.chat_id
          JOIN handle h ON chj.handle_id = h.ROWID
          WHERE h.id LIKE ?
        `).all(contactPattern);
      }
    }

    if (chats.length === 0) {
      db.close();
      return {
        content: [
          {
            type: 'text',
            text: `No conversation found with "${contact}".`,
          },
        ],
      };
    }

    // Get all messages from these chats
    const chatIds = chats.map(c => c.chat_id).join(',');

    // Build date filter if hours_ago is specified
    let dateFilter = '';
    if (hoursAgo) {
      const secondsAgo = hoursAgo * 3600;
      dateFilter = `AND m.date > (strftime('%s', 'now') - ${secondsAgo} - strftime('%s', '2001-01-01')) * 1000000000`;
    }

    const conversationQuery = `
      SELECT
        m.ROWID,
        m.text,
        m.attributedBody,
        m.is_from_me,
        m.cache_has_attachments,
        datetime(m.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') as date,
        h.id as contact
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
      WHERE cmj.chat_id IN (${chatIds})
      AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
      ${dateFilter}
      ORDER BY m.date DESC
      LIMIT ?
    `;

    const messages = db.prepare(conversationQuery).all(limit);

    // For messages with attachments, fetch attachment info
    const messageIds = messages.filter(m => m.cache_has_attachments).map(m => m.ROWID);
    let attachmentMap = {};
    if (messageIds.length > 0) {
      const attachQuery = `
        SELECT
          maj.message_id,
          a.ROWID as attachment_id,
          a.filename,
          a.mime_type,
          a.transfer_name
        FROM message_attachment_join maj
        JOIN attachment a ON maj.attachment_id = a.ROWID
        WHERE maj.message_id IN (${messageIds.join(',')})
      `;
      const attachments = db.prepare(attachQuery).all();
      for (const att of attachments) {
        if (!attachmentMap[att.message_id]) attachmentMap[att.message_id] = [];
        attachmentMap[att.message_id].push(att);
      }
    }

    db.close();

    // Reverse to show chronological order
    const formattedMessages = messages.reverse().map(msg => {
      const from = msg.is_from_me ? 'You' : this.resolveHandleToName(msg.contact || contact);
      const text = this.getMessageText(msg) || '';

      // Build attachment indicator
      let attachmentInfo = '';
      if (attachmentMap[msg.ROWID]) {
        const atts = attachmentMap[msg.ROWID].map(a => {
          const name = a.transfer_name || path.basename(a.filename || 'file');
          const mime = a.mime_type || '';
          if (mime.startsWith('image/')) return `[image: ${name}]`;
          if (mime.startsWith('video/')) return `[video: ${name}]`;
          if (mime.startsWith('audio/')) return `[audio: ${name}]`;
          return `[file: ${name}]`;
        });
        attachmentInfo = ` ${atts.join(' ')}`;
      }

      return `[${msg.date}] ${from} (ID: ${msg.ROWID}): ${text}${attachmentInfo}`;
    }).filter(line => {
      // Filter out empty messages with no attachments
      const match = line.match(/\(ID: \d+\): (.*)$/);
      return match && match[1].trim().length > 0;
    }).join('\n\n');

    const timeInfo = hoursAgo ? ` (last ${hoursAgo} hours)` : '';
    return {
      content: [
        {
          type: 'text',
          text: formattedMessages || `No messages found with "${contact}"${timeInfo}.`,
        },
      ],
    };
  }

  async listChatsStructured(args = {}) {
    const db = this.openDatabase();
    try {
      const chats = this.fetchChatSummaries(db, {
        limit: args.limit || 20,
        hours_ago: args.hours_ago || null,
      });
      return this.jsonResponse({
        tool: 'list_chats_structured',
        hours_ago: args.hours_ago || null,
        limit: args.limit || 20,
        count: chats.length,
        chats,
      });
    } finally {
      db.close();
    }
  }

  async getConversationByChatId(args = {}) {
    const chatId = Number(args.chat_id);
    if (!Number.isInteger(chatId) || chatId <= 0) {
      return {
        content: [{ type: 'text', text: 'Missing or invalid chat_id.' }],
        isError: true,
      };
    }

    const db = this.openDatabase();
    try {
      const conversation = this.fetchConversationDataByChatId(db, chatId, {
        limit: args.limit || 100,
        hours_ago: args.hours_ago || null,
      });

      if (!conversation) {
        return {
          content: [{ type: 'text', text: `No conversation found for chat_id ${chatId}.` }],
        };
      }

      return this.jsonResponse({
        tool: 'get_conversation_by_chat_id',
        hours_ago: args.hours_ago || null,
        limit: args.limit || 100,
        conversation,
      });
    } finally {
      db.close();
    }
  }

  async findOutreachFollowups(args = {}) {
    const hoursAgo = args.hours_ago || 168;
    const limit = args.limit || 100;
    const maxResults = args.max_results || 50;
    const db = this.openDatabase();

    try {
      const chats = this.fetchChatSummaries(db, { limit, hours_ago: hoursAgo })
        .filter(chat => !chat.is_group);
      const results = [];
      const summary = {
        inspected_chats: chats.length,
        with_outreach: 0,
        candidate: 0,
        negative_or_opt_out: 0,
        unclear: 0,
        awaiting_reply: 0,
        already_followed_up: 0,
      };

      for (const chat of chats) {
        const conversation = this.fetchConversationDataByChatId(db, chat.chat_id, {
          limit: args.conversation_limit || 100,
          hours_ago: hoursAgo,
        });
        if (!conversation) continue;

        const classified = classifyConversation(conversation, {
          hours_ago: hoursAgo,
          outreach_terms: args.outreach_terms,
        });
        if (!classified) continue;

        summary.with_outreach += 1;
        if (Object.prototype.hasOwnProperty.call(summary, classified.status)) {
          summary[classified.status] += 1;
        }
        results.push(classified);
        if (results.length >= maxResults) break;
      }

      return this.jsonResponse({
        tool: 'find_outreach_followups',
        hours_ago: hoursAgo,
        inspected_limit: limit,
        max_results: maxResults,
        count: results.length,
        summary,
        results,
      });
    } finally {
      db.close();
    }
  }

  async getAttachment(args) {
    const messageId = args.message_id;

    const db = this.openDatabase();

    const query = `
      SELECT
        a.ROWID as attachment_id,
        a.filename,
        a.mime_type,
        a.transfer_name,
        a.total_bytes
      FROM message_attachment_join maj
      JOIN attachment a ON maj.attachment_id = a.ROWID
      WHERE maj.message_id = ?
    `;

    const attachments = db.prepare(query).all(messageId);
    db.close();

    if (attachments.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No attachments found for message ID ${messageId}.`,
          },
        ],
      };
    }

    const contentBlocks = [];

    for (const att of attachments) {
      const filePath = this.resolveAttachmentPath(att.filename);
      const name = att.transfer_name || path.basename(att.filename || 'file');
      const mime = att.mime_type || this.getMimeType(name);

      if (!filePath || !fs.existsSync(filePath)) {
        contentBlocks.push({
          type: 'text',
          text: `${name} (${mime}, ${att.total_bytes} bytes) - file not found on disk`,
        });
        continue;
      }

      // For images, return as base64 image content so Claude can see them
      if (mime.startsWith('image/') && !mime.includes('heic') && !mime.includes('heif')) {
        try {
          const data = fs.readFileSync(filePath);
          contentBlocks.push({
            type: 'image',
            data: data.toString('base64'),
            mimeType: mime,
          });
          contentBlocks.push({
            type: 'text',
            text: `${name} (${mime}, ${att.total_bytes} bytes)`,
          });
        } catch (err) {
          contentBlocks.push({
            type: 'text',
            text: `${name} - failed to read: ${err.message}`,
          });
        }
      } else if (mime.startsWith('image/') && (mime.includes('heic') || mime.includes('heif'))) {
        // HEIC needs conversion to JPEG for Claude to view
        try {
          const tmpPath = `/tmp/imessage_${att.attachment_id}.jpg`;
          execSync(`sips -s format jpeg "${filePath}" --out "${tmpPath}" 2>/dev/null`);
          const data = fs.readFileSync(tmpPath);
          contentBlocks.push({
            type: 'image',
            data: data.toString('base64'),
            mimeType: 'image/jpeg',
          });
          contentBlocks.push({
            type: 'text',
            text: `${name} (converted from HEIC, ${att.total_bytes} bytes)`,
          });
          fs.unlinkSync(tmpPath);
        } catch (err) {
          contentBlocks.push({
            type: 'text',
            text: `${name} (HEIC) - conversion failed: ${err.message}`,
          });
        }
      } else {
        // Non-image files: return metadata
        contentBlocks.push({
          type: 'text',
          text: `${name} (${mime}, ${att.total_bytes} bytes)\n   Path: ${filePath}`,
        });
      }
    }

    return { content: contentBlocks };
  }

  buildSendScript(sanitizedTo, sanitizedMessage, serviceType) {
    return `
      tell application "Messages"
        set targetService to 1st account whose service type = ${serviceType}
        set targetBuddy to participant "${sanitizedTo}" of targetService
        send "${sanitizedMessage}" to targetBuddy
      end tell
    `;
  }

  escapeAppleScriptString(value) {
    return String(value || '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r?\n/g, ' ');
  }

  buildCleanupFailedMessageScript(to, message) {
    const sanitizedTo = this.escapeAppleScriptString(to.replace(/["'\\]/g, ''));
    const snippet = this.escapeAppleScriptString(message.replace(/\s+/g, ' ').trim().slice(0, 70));

    return `
      set targetRecipient to "${sanitizedTo}"
      set targetSnippet to "${snippet}"

      tell application "Messages" to activate
      delay 0.2
      open location "sms:" & targetRecipient
      delay 0.8

      tell application "System Events"
        tell process "Messages"
          set frontmost to true
          delay 0.3
          if not (exists front window) then error "Messages window not found"

          set matchedElement to missing value
          try
            set allElements to entire contents of front window
            repeat with candidate in allElements
              try
                if (role of candidate is "AXStaticText") then
                  set candidateValue to value of candidate as text
                  if candidateValue contains targetSnippet then
                    set matchedElement to candidate
                    exit repeat
                  end if
                end if
              end try
            end repeat
          end try

          if matchedElement is missing value then error "Failed message bubble not found in visible transcript"

          click matchedElement
          delay 0.2
          key code 51
          delay 0.4

          if exists sheet 1 of front window then
            tell sheet 1 of front window
              if exists button "Delete" then
                click button "Delete"
              else if exists button "Delete Message" then
                click button "Delete Message"
              else
                error "Delete confirmation button not found"
              end if
            end tell
          else if exists button "Delete" of front window then
            click button "Delete" of front window
          end if
        end tell
      end tell
    `;
  }

  releaseEnabled(flag) {
    return this.releaseFlags.has(flag);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getVerifyDelayMs() {
    const value = Number(process.env.IMESSAGE_MCP_SEND_VERIFY_DELAY_MS || DEFAULT_SEND_VERIFY_DELAY_MS);
    if (!Number.isFinite(value) || value < 0) return DEFAULT_SEND_VERIFY_DELAY_MS;
    return value;
  }

  normalizeHandleForCompare(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.includes('@')) return trimmed.toLowerCase();
    return this.normalizePhoneNumber(trimmed) || trimmed.toLowerCase();
  }

  isPhoneRecipient(to) {
    return Boolean(this.normalizePhoneNumber(to));
  }

  resolveRecipient(to) {
    if (typeof to !== 'string' || to.trim().length === 0) {
      throw new Error('Missing recipient.');
    }

    let resolvedTo = to.trim();
    const looksLikeId = resolvedTo.includes('@') || resolvedTo.includes('+') || /^\d{7,}$/.test(resolvedTo);
    if (!looksLikeId) {
      const resolved = this.resolveNameToHandleIds(resolvedTo);
      if (resolved.length > 0) {
        const db = this.openDatabase();
        try {
          const allHandles = db.prepare('SELECT id FROM handle').all();
          for (const h of allHandles) {
            const hn = this.normalizeHandleForCompare(h.id);
            if (hn && resolved.includes(hn)) {
              resolvedTo = h.id;
              break;
            }
          }
        } finally {
          db.close();
        }
      }
    }
    return resolvedTo;
  }

  runSendScript(to, message, serviceType) {
    const sanitizedTo = to.replace(/["'\\]/g, '');
    const sanitizedMessage = message.replace(/"/g, '\\"');
    this.runScript(this.buildSendScript(sanitizedTo, sanitizedMessage, serviceType));
  }

  getMatchingHandles(db, recipient) {
    const normalizedRecipient = this.normalizeHandleForCompare(recipient);
    if (!normalizedRecipient) return [];

    return db.prepare('SELECT ROWID, id FROM handle').all()
      .filter(handle => this.normalizeHandleForCompare(handle.id) === normalizedRecipient);
  }

  getMaxMessageRowId() {
    const db = this.openDatabase();
    try {
      const row = db.prepare('SELECT COALESCE(MAX(ROWID), 0) as max_rowid FROM message').get();
      return Number(row.max_rowid || 0);
    } finally {
      db.close();
    }
  }

  hydrateDeliveryRow(row) {
    if (!row) return null;
    const text = this.getMessageText(row) || '';
    const error = Number(row.error || 0);
    const isSent = Number(row.is_sent || 0);
    const isDelivered = Number(row.is_delivered || 0);
    let deliveryStatus = 'pending';
    if (error !== 0) {
      deliveryStatus = 'failed';
    } else if (isSent === 1 || isDelivered === 1) {
      deliveryStatus = 'sent';
    }

    return {
      message_id: String(row.ROWID),
      guid: row.guid || null,
      date: row.date || null,
      apple_date: row.apple_date || null,
      handle: row.handle || null,
      display_name: row.handle ? this.resolveHandleToName(row.handle) : null,
      service: row.service || null,
      delivery_status: deliveryStatus,
      error,
      is_sent: isSent,
      is_delivered: isDelivered,
      was_downgraded: Number(row.was_downgraded || 0),
      text,
    };
  }

  getOutgoingStatusSince(recipient, message, minRowId) {
    const normalizedRecipient = this.normalizeHandleForCompare(recipient);
    const db = this.openDatabase();
    try {
      const rows = db.prepare(`
        SELECT
          m.ROWID,
          m.guid,
          m.text,
          m.attributedBody,
          m.service,
          m.error,
          m.is_sent,
          m.is_delivered,
          m.was_downgraded,
          m.date as apple_date,
          datetime(m.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') as date,
          h.id as handle
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE m.is_from_me = 1
          AND m.ROWID > ?
        ORDER BY m.ROWID DESC
        LIMIT 100
      `).all(minRowId);

      for (const row of rows) {
        const text = this.getMessageText(row) || '';
        if (text !== message) continue;
        const normalizedHandle = this.normalizeHandleForCompare(row.handle || '');
        if (!normalizedRecipient || !normalizedHandle || normalizedRecipient === normalizedHandle) {
          return this.hydrateDeliveryRow(row);
        }
      }
      return null;
    } finally {
      db.close();
    }
  }

  getMessageByGuid(guid) {
    if (!guid) return null;
    const db = this.openDatabase();
    try {
      const row = db.prepare(`
        SELECT
          m.ROWID,
          m.guid,
          m.text,
          m.attributedBody,
          m.service,
          m.error,
          m.is_sent,
          m.is_delivered,
          m.was_downgraded,
          m.date as apple_date,
          datetime(m.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') as date,
          h.id as handle
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE m.guid = ?
        LIMIT 1
      `).get(guid);
      return this.hydrateDeliveryRow(row);
    } finally {
      db.close();
    }
  }

  getServiceEvidence(recipient, limit = 20) {
    const resolvedRecipient = this.resolveRecipient(recipient);
    const db = this.openDatabase();
    try {
      const handles = this.getMatchingHandles(db, resolvedRecipient);
      const result = {
        recipient: resolvedRecipient,
        release_flags: Array.from(this.releaseFlags),
        matching_handles: handles.map(handle => ({
          handle_id: handle.ROWID,
          handle: handle.id,
          display_name: this.resolveHandleToName(handle.id),
        })),
        recommended_service: this.isPhoneRecipient(resolvedRecipient) ? 'auto' : 'imessage',
        confidence: handles.length ? 'medium' : 'low',
        reason: handles.length ? 'Based on recent Messages history.' : 'No prior Messages handle found. Use auto unless you know the recipient is SMS-only.',
        recent_messages: [],
      };

      if (handles.length === 0) return result;

      const placeholders = handles.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT
          m.ROWID,
          m.guid,
          m.text,
          m.attributedBody,
          m.service,
          m.error,
          m.is_sent,
          m.is_delivered,
          m.was_downgraded,
          m.is_from_me,
          m.date as apple_date,
          datetime(m.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') as date,
          h.id as handle
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE m.handle_id IN (${placeholders})
        ORDER BY m.date DESC
        LIMIT ?
      `).all(...handles.map(handle => handle.ROWID), limit);

      const hydrated = rows.map(row => ({
        ...this.hydrateDeliveryRow(row),
        from_me: Boolean(row.is_from_me),
      }));
      result.recent_messages = hydrated;

      const recentOutgoing = hydrated.filter(row => row.from_me);
      const recentFailedImessage = recentOutgoing.find(row => row.service === 'iMessage' && row.delivery_status === 'failed');
      const latestOutgoingService = recentOutgoing[0]?.service || null;
      const hasSmsThread = hydrated.some(row => ['SMS', 'RCS'].includes(row.service));

      if (this.isPhoneRecipient(resolvedRecipient) && (recentFailedImessage || ['SMS', 'RCS'].includes(latestOutgoingService) || hasSmsThread)) {
        result.recommended_service = 'sms';
        result.confidence = recentFailedImessage ? 'high' : 'medium';
        result.reason = recentFailedImessage
          ? 'Recent iMessage send failed for this handle. SMS/RCS is safer.'
          : 'Recent thread evidence uses SMS/RCS.';
      } else if (latestOutgoingService === 'iMessage' || hydrated.some(row => row.service === 'iMessage')) {
        result.recommended_service = 'imessage';
        result.confidence = 'medium';
        result.reason = 'Recent thread evidence uses iMessage.';
      }

      return result;
    } finally {
      db.close();
    }
  }

  sendResolvedMessage(to, message, service = 'auto') {
    if (service === 'imessage') {
      try {
        this.runSendScript(to, message, 'iMessage');
        return { service: 'imessage', text: `iMessage sent to ${to}: "${message}"` };
      } catch (error) {
        throw new Error(`Failed to send iMessage: ${error.message}`);
      }
    }

    if (service === 'sms') {
      try {
        this.runSendScript(to, message, 'SMS');
        return { service: 'sms', text: `SMS sent to ${to}: "${message}"` };
      } catch (error) {
        throw new Error(`Failed to send SMS: ${error.message}. Make sure your iPhone is nearby and Bluetooth is on (required for SMS relay).`);
      }
    }

    try {
      this.runSendScript(to, message, 'iMessage');
      return { service: 'imessage', text: `iMessage sent to ${to}: "${message}"` };
    } catch {
      try {
        this.runSendScript(to, message, 'SMS');
        return { service: 'sms', text: `SMS sent to ${to}: "${message}" (sent as SMS, recipient may not have iMessage)` };
      } catch (smsError) {
        throw new Error(`Failed to send as iMessage or SMS: ${smsError.message}. For SMS, ensure your iPhone is nearby with Bluetooth on.`);
      }
    }
  }

  formatSendOutcome(result, to, message) {
    const serviceLabel = result.service === 'sms' ? 'SMS/RCS' : 'iMessage';
    const status = result.delivery_status || 'unknown';
    const fallback = result.fallback_from
      ? ` Fallback used after ${result.fallback_from} reported ${result.fallback_reason || 'failure'}.`
      : '';
    const cleanup = result.cleanup_failed_imessage
      ? ` Failed iMessage cleanup: ${result.cleanup_failed_imessage.ok ? 'deleted' : 'not deleted'}.`
      : '';
    return `${serviceLabel} ${status} to ${to}: "${message}"${fallback}${cleanup}`;
  }

  async sendAndVerify(to, message, service, options = {}) {
    const scriptService = service === 'sms' ? 'SMS' : 'iMessage';
    const minRowId = this.getMaxMessageRowId();

    try {
      this.runSendScript(to, message, scriptService);
    } catch (error) {
      if (options.returnFailure) {
        return {
          service,
          delivery_status: 'script_failed',
          error: error.message,
          text: `${scriptService} send failed before Messages accepted it: ${error.message}`,
        };
      }
      const suffix = service === 'sms'
        ? ' Make sure your iPhone is nearby and Bluetooth is on for SMS relay.'
        : '';
      throw new Error(`Failed to send ${scriptService}: ${error.message}.${suffix}`);
    }

    await this.sleep(this.getVerifyDelayMs());
    const status = this.getOutgoingStatusSince(to, message, minRowId);
    const result = {
      service,
      delivery_status: status ? status.delivery_status : 'unknown',
      delivery_evidence: status,
    };
    result.text = this.formatSendOutcome(result, to, message);

    if (result.delivery_status === 'failed' && options.throwOnVerifiedFailure !== false) {
      throw new Error(`${scriptService} send was accepted by Messages but marked Not Delivered. error=${status.error}`);
    }

    return result;
  }

  async sendResolvedMessageWithVerification(to, message, service = 'auto') {
    if (service === 'imessage') {
      return this.sendAndVerify(to, message, 'imessage');
    }

    if (service === 'sms') {
      return this.sendAndVerify(to, message, 'sms');
    }

    const canUseSms = this.isPhoneRecipient(to);
    const evidence = this.getServiceEvidence(to, 20);
    if (canUseSms && evidence.recommended_service === 'sms') {
      return this.sendAndVerify(to, message, 'sms');
    }

    const imessageAttempt = await this.sendAndVerify(to, message, 'imessage', {
      throwOnVerifiedFailure: false,
      returnFailure: true,
    });

    if (canUseSms && ['failed', 'script_failed'].includes(imessageAttempt.delivery_status)) {
      const fallback = await this.sendAndVerify(to, message, 'sms');
      fallback.fallback_from = 'imessage';
      fallback.fallback_reason = imessageAttempt.delivery_status;
      if (
        fallback.delivery_status !== 'failed'
        && imessageAttempt.delivery_status === 'failed'
        && this.releaseEnabled(RELEASE_CLEANUP_FAILED_IMESSAGE)
      ) {
        fallback.cleanup_failed_imessage = await this.cleanupFailedImessageAfterSmsFallback(to, message, imessageAttempt);
      }
      fallback.text = this.formatSendOutcome(fallback, to, message);
      return fallback;
    }

    if (imessageAttempt.delivery_status === 'script_failed') {
      throw new Error(`Failed to send as iMessage and recipient is not SMS-capable: ${imessageAttempt.error}`);
    }

    return imessageAttempt;
  }

  async cleanupFailedImessageAfterSmsFallback(to, message, imessageAttempt) {
    const evidence = imessageAttempt.delivery_evidence || null;
    if (!evidence?.guid) {
      return {
        attempted: false,
        ok: false,
        reason: 'No failed iMessage GUID found to verify cleanup.',
      };
    }

    try {
      this.runScript(this.buildCleanupFailedMessageScript(to, message));
      await this.sleep(600);
      const remaining = this.getMessageByGuid(evidence.guid);
      return {
        attempted: true,
        ok: !remaining,
        method: 'messages_ui_delete',
        failed_message_guid: evidence.guid,
        failed_message_id: evidence.message_id || null,
        verification: remaining ? 'failed_message_still_present' : 'failed_message_not_found',
      };
    } catch (error) {
      return {
        attempted: true,
        ok: false,
        method: 'messages_ui_delete',
        failed_message_guid: evidence.guid,
        failed_message_id: evidence.message_id || null,
        error: error.message,
      };
    }
  }

  async detectMessageService(args = {}) {
    if (typeof args.to !== 'string' || args.to.trim().length === 0) {
      return {
        content: [{ type: 'text', text: 'Missing required recipient: to.' }],
        isError: true,
      };
    }

    return this.jsonResponse({
      tool: 'detect_message_service',
      ...this.getServiceEvidence(args.to, args.limit || 20),
    });
  }

  getRecoveryForDeliveryIssue(db, issue) {
    if (!issue.handle) return null;
    const rows = db.prepare(`
      SELECT
        m.ROWID,
        m.guid,
        m.text,
        m.attributedBody,
        m.service,
        m.error,
        m.is_sent,
        m.is_delivered,
        m.was_downgraded,
        m.date as apple_date,
        datetime(m.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') as date,
        h.id as handle
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      WHERE m.is_from_me = 1
        AND h.id = ?
        AND m.ROWID > ?
      ORDER BY m.ROWID ASC
      LIMIT 8
    `).all(issue.handle, Number(issue.message_id));

    return rows
      .map(row => this.hydrateDeliveryRow(row))
      .find(row => row && row.delivery_status !== 'failed' && row.service !== issue.service) || null;
  }

  async listDeliveryFailures(args = {}) {
    const hoursAgo = Number(args.hours_ago || 24);
    const limit = Number(args.limit || 50);
    const includePending = args.include_pending !== false;
    const secondsAgo = Number.isFinite(hoursAgo) && hoursAgo > 0 ? hoursAgo * 3600 : 24 * 3600;
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
    const pendingClause = includePending ? 'OR (COALESCE(m.error, 0) = 0 AND COALESCE(m.is_sent, 0) = 0)' : '';
    const db = this.openDatabase();

    try {
      const rows = db.prepare(`
        SELECT
          m.ROWID,
          m.guid,
          m.text,
          m.attributedBody,
          m.service,
          m.error,
          m.is_sent,
          m.is_delivered,
          m.was_downgraded,
          m.date as apple_date,
          datetime(m.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') as date,
          h.id as handle
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE m.is_from_me = 1
          AND m.date > (strftime('%s', 'now') - ? - strftime('%s', '2001-01-01')) * 1000000000
          AND (COALESCE(m.error, 0) != 0 ${pendingClause})
        ORDER BY m.date DESC
        LIMIT ?
      `).all(secondsAgo, safeLimit);

      const issues = rows.map(row => {
        const issue = this.hydrateDeliveryRow(row);
        return {
          ...issue,
          recovered_by: this.getRecoveryForDeliveryIssue(db, issue),
        };
      });

      return this.jsonResponse({
        tool: 'list_delivery_failures',
        hours_ago: hoursAgo,
        include_pending: includePending,
        count: issues.length,
        issues,
      });
    } finally {
      db.close();
    }
  }

  async sendMessage(args) {
    let { to, message, confirm, service = 'auto' } = args;
    to = this.resolveRecipient(to);
    if (typeof message !== 'string' || message.trim().length === 0) {
      return {
        content: [{ type: 'text', text: 'Missing required message text.' }],
        isError: true,
      };
    }
    if (!['auto', 'imessage', 'sms'].includes(service)) {
      return {
        content: [{ type: 'text', text: 'Invalid service. Use auto, imessage, or sms.' }],
        isError: true,
      };
    }

    if (!confirm) {
      const serviceLabel = service === 'sms' ? 'SMS (green bubble)' : service === 'imessage' ? 'iMessage (blue bubble)' : 'iMessage or SMS (auto)';
      const releaseInfo = [
        `Verified fallback: ${this.releaseEnabled(RELEASE_AUTO_SMS_FALLBACK) ? 'enabled' : 'disabled'}`,
        `Failed iMessage cleanup: ${this.releaseEnabled(RELEASE_CLEANUP_FAILED_IMESSAGE) ? 'enabled' : 'disabled'}`,
      ].join('\n');
      return {
        content: [
          {
            type: 'text',
            text: `Message NOT sent. Confirmation required.\n\nTo: ${to}\nMessage: "${message}"\nService: ${serviceLabel}\n${releaseInfo}\n\nTo send this message, set confirm=true.`,
          },
        ],
      };
    }

    const sent = this.releaseEnabled(RELEASE_AUTO_SMS_FALLBACK)
      ? await this.sendResolvedMessageWithVerification(to, message, service)
      : this.sendResolvedMessage(to, message, service);
    return { content: [{ type: 'text', text: sent.text }] };
  }

  async sendMessageBatch(args = {}) {
    const items = args.items || [];
    const service = args.service || 'sms';
    const validation = validateBatch(items, { maxItems: DEFAULT_MAX_BATCH_SIZE });
    const approvalToken = createApprovalToken(items, service);

    if (!validation.ok) {
      return this.jsonResponse({
        tool: 'send_message_batch',
        ok: false,
        sent: false,
        errors: validation.errors,
        warnings: validation.warnings,
        max_batch_size: DEFAULT_MAX_BATCH_SIZE,
      });
    }

    const preview = {
      tool: 'send_message_batch',
      ok: true,
      sent: false,
      service,
      count: items.length,
      max_batch_size: DEFAULT_MAX_BATCH_SIZE,
      approval_token: approvalToken,
      warnings: validation.warnings,
      items: items.map((item, index) => ({
        index: index + 1,
        to: item.to,
        message: item.message,
        candidate_id: item.candidate_id || null,
        risk_level: item.risk_level || null,
        risk_labels: Array.isArray(item.risk_labels) ? item.risk_labels : [],
      })),
    };

    if (!args.confirm) {
      return this.jsonResponse(preview);
    }

    if (args.approval_token !== approvalToken) {
      return {
        content: [
          {
            type: 'text',
            text: 'Batch NOT sent. approval_token does not match this exact batch preview.',
          },
        ],
        isError: true,
      };
    }

    const sent = [];
    for (const item of items) {
      const to = this.resolveRecipient(item.to);
      try {
        const result = this.releaseEnabled(RELEASE_AUTO_SMS_FALLBACK)
          ? await this.sendResolvedMessageWithVerification(to, item.message, service)
          : this.sendResolvedMessage(to, item.message, service);
        sent.push({
          to,
          candidate_id: item.candidate_id || null,
          service: result.service,
          delivery_status: result.delivery_status || null,
          fallback_from: result.fallback_from || null,
          cleanup_failed_imessage: result.cleanup_failed_imessage || null,
          message: item.message,
        });
      } catch (error) {
        return this.jsonResponse({
          tool: 'send_message_batch',
          ok: false,
          sent: false,
          error: error.message,
          sent_before_error: sent,
        });
      }
    }

    return this.jsonResponse({
      tool: 'send_message_batch',
      ok: true,
      sent: true,
      service,
      count: sent.length,
      warnings: validation.warnings,
      sent_items: sent,
    });
  }

  async listRecentChats(args) {
    const limit = args.limit || 20;
    const hoursAgo = args.hours_ago || null;

    const db = this.openDatabase();

    let dateFilter = '';
    if (hoursAgo) {
      const secondsAgo = hoursAgo * 3600;
      dateFilter = `WHERE m.date > (strftime('%s', 'now') - ${secondsAgo} - strftime('%s', '2001-01-01')) * 1000000000`;
    }

    const query = `
      SELECT
        c.ROWID as chat_id,
        c.chat_identifier,
        c.display_name,
        MAX(datetime(m.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime')) as last_message_date,
        COUNT(m.ROWID) as message_count,
        h.id as handle
      FROM chat c
      JOIN chat_message_join cmj ON c.ROWID = cmj.chat_id
      JOIN message m ON cmj.message_id = m.ROWID
      LEFT JOIN chat_handle_join chj ON c.ROWID = chj.chat_id
      LEFT JOIN handle h ON chj.handle_id = h.ROWID
      ${dateFilter}
      GROUP BY c.ROWID
      ORDER BY MAX(m.date) DESC
      LIMIT ?
    `;

    const chats = db.prepare(query).all(limit);
    db.close();

    const formattedChats = chats.map((chat, i) => {
      const resolvedName = chat.handle ? this.resolveHandleToName(chat.handle) : null;
      const identifier = chat.display_name || resolvedName || chat.chat_identifier;
      return `${i + 1}. ${identifier}\n   Last message: ${chat.last_message_date}\n   Messages: ${chat.message_count}`;
    }).join('\n\n');

    const timeInfo = hoursAgo ? ` (last ${hoursAgo} hours)` : '';
    return {
      content: [
        {
          type: 'text',
          text: `Recent Conversations${timeInfo}:\n\n${formattedChats}`,
        },
      ],
    };
  }

  async lookupContact(args) {
    const name = args.name;
    this.ensureContactCache();

    const dbPaths = this.getAddressBookPaths();
    const results = [];
    const seen = new Set();
    const lowerName = name.toLowerCase().trim();

    for (const dbPath of dbPaths) {
      let db;
      try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
      } catch {
        continue;
      }

      try {
        const pattern = `%${lowerName}%`;
        const contacts = db.prepare(`
          SELECT DISTINCT r.Z_PK, r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, r.ZNICKNAME
          FROM ZABCDRECORD r
          WHERE (
            LOWER(r.ZFIRSTNAME) LIKE ?
            OR LOWER(r.ZLASTNAME) LIKE ?
            OR LOWER(r.ZORGANIZATION) LIKE ?
            OR LOWER(r.ZNICKNAME) LIKE ?
            OR LOWER(COALESCE(r.ZFIRSTNAME,'') || ' ' || COALESCE(r.ZLASTNAME,'')) LIKE ?
          )
        `).all(pattern, pattern, pattern, pattern, pattern);

        for (const c of contacts) {
          const displayName = this.buildDisplayName(c);
          if (!displayName || seen.has(displayName.toLowerCase())) continue;
          seen.add(displayName.toLowerCase());

          const phones = db.prepare(
            'SELECT ZFULLNUMBER, ZLABEL FROM ZABCDPHONENUMBER WHERE ZOWNER = ?'
          ).all(c.Z_PK);

          const emails = db.prepare(
            'SELECT ZADDRESS, ZLABEL FROM ZABCDEMAILADDRESS WHERE ZOWNER = ?'
          ).all(c.Z_PK);

          results.push({ name: displayName, phones, emails });
        }
      } catch {
        // Skip databases that fail to query
      } finally {
        db.close();
      }
    }

    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: `No contacts found matching "${name}".` }],
      };
    }

    const formatted = results.map((contact, i) => {
      const phoneList = contact.phones.length > 0
        ? `\n   Phones: ${contact.phones.map(p => p.ZFULLNUMBER).join(', ')}`
        : '';
      const emailList = contact.emails.length > 0
        ? `\n   Emails: ${contact.emails.map(e => e.ZADDRESS).join(', ')}`
        : '';
      return `${i + 1}. ${contact.name}${phoneList}${emailList}`;
    }).join('\n\n');

    return {
      content: [
        { type: 'text', text: `Found ${results.length} contact(s) matching "${name}":\n\n${formatted}` },
      ],
    };
  }

  async reactToMessage(args) {
    const { message_id, reaction, confirm } = args;

    const reactionMap = {
      'love': '0',
      'like': '1',
      'dislike': '2',
      'laugh': '3',
      'emphasize': '4',
      'question': '5',
    };

    const reactionEmoji = {
      'love': '❤️',
      'like': '👍',
      'dislike': '👎',
      'laugh': '😂',
      'emphasize': '‼️',
      'question': '❓',
    };

    if (!confirm) {
      return {
        content: [
          {
            type: 'text',
            text: `Reaction NOT sent. Confirmation required.\n\nMessage ID: ${message_id}\nReaction: ${reactionEmoji[reaction]} (${reaction})\n\nTo send this reaction, set confirm=true.`,
          },
        ],
      };
    }

    const reactionType = reactionMap[reaction];

    const script = `
      tell application "Messages"
        set targetMessage to a reference to message id ${message_id}
        add reaction ${reactionType} to targetMessage
      end tell
    `;

    try {
      execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
      return {
        content: [
          {
            type: 'text',
            text: `Reaction sent: ${reactionEmoji[reaction]} to message ${message_id}`,
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to send reaction: ${error.message}. Note: Reactions may not work on all iMessage versions.`);
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`iMessage MCP server v${SERVER_VERSION} running on stdio`);
  }
}

if (require.main === module) {
  const server = new IMessageServer();
  server.run().catch(console.error);
}

module.exports = { IMessageServer };
