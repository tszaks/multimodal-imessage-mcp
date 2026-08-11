# Multimodal iMessage MCP

The most complete iMessage MCP server for Claude. Read full conversations, search messages, **view image attachments**, send messages, look up contacts, and react to messages -- all from Claude Desktop or Claude Code.

## Why This Exists

Every other iMessage MCP tool queries the `text` column in Apple's `chat.db`. The problem? **On modern macOS (14+), 93% of messages are stored in `attributedBody` instead of `text`.** Those tools silently return empty or incomplete conversations.

This server reverse-engineers Apple's `NSAttributedString` binary format to extract the actual message content, giving you access to your *complete* message history.

## Features

| Tool | Description |
|------|-------------|
| `read_recent_messages` | Read your latest messages across all conversations |
| `search_messages` | Full-text search across all messages, contacts, and group names |
| `get_conversation` | Get a complete conversation thread with any contact (by name or number) |
| `list_chats_structured` | Get chat IDs, handles, last sender, previews, and group status as JSON |
| `get_conversation_by_chat_id` | Get a reliable structured thread by chat ID |
| `read_receipts` release flag | Adds best-effort read receipt metadata for outgoing 1:1 iMessage/RCS messages |
| `find_outreach_followups` | Find SMS outreach threads that need follow-up review |
| `get_attachment` | **View images and files** from messages -- Claude can see and analyze photos |
| `send_message` | Send iMessages or SMS/RCS with confirmation safety and optional verified fallback |
| `detect_message_service` | Inspect a thread and recommend iMessage, SMS/RCS, or auto before sending |
| `send_message_batch` | Preview and send reviewed batches with an approval token |
| `list_delivery_failures` | List red-bubble send failures, pending sends, and SMS/RCS recoveries |
| `delete_messages` | Delete exact local message rows with backup-first DB cleanup |
| `delete_threads` | Preview and delete full local threads with one exact-batch approval token |
| `edit_message` | Experimentally edit a recent outgoing iMessage through Messages UI automation |
| `undo_send_message` | Experimentally undo send for a recent outgoing iMessage through Messages UI automation |
| `list_recent_chats` | See your most active conversations |
| `lookup_contact` | Find phone numbers and emails from your Contacts |
| `react_to_message` | Add tapback reactions to messages |

### Multimodal: Claude Can See Your Photos

When you use `get_attachment`, images are returned as base64 content blocks that Claude can actually *look at*. HEIC photos (iPhone default) are automatically converted to JPEG. This means Claude can:

- Describe what's in a photo someone sent you
- Read text/screenshots from images
- Analyze visual content in your conversations

## Requirements

- **macOS** (this reads the local iMessage database)
- **Node.js** >= 18 and < 26. Node 24 LTS is recommended because the locked
  native SQLite dependency is not compatible with Node 26.
- **Full Disk Access** granted to your terminal app (System Settings > Privacy & Security > Full Disk Access). This covers both the iMessage database and the AddressBook database used for contact name resolution — no need to have the Contacts app running.

## Installation

```bash
git clone https://github.com/tszaks/imessage-mcp.git
cd imessage-mcp
npm install
```

## Configuration

### Claude Desktop

Add to your `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "imessage": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/imessage-mcp/index.js"]
    }
  }
}
```

> **Important:** Use the full path to your Node.js binary (e.g., `/opt/homebrew/bin/node`), not just `node`. macOS desktop apps don't inherit your shell's PATH, and using a bare `node` command often resolves to an older system Node that causes native module crashes.

### Claude Code

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "imessage": {
      "command": "node",
      "args": ["/path/to/imessage-mcp/index.js"]
    }
  }
}
```

> In Claude Code, `node` typically resolves correctly since it inherits your shell environment.

## Usage Examples

**"Show me my recent messages"** -- reads your latest conversations

**"What did Mom text me today?"** -- resolves "Mom" to a phone number via your AddressBook, pulls the conversation

**"Search my messages for 'flight confirmation'"** -- full-text search across all messages

**"Find outreach prospects from the last 7 days who replied and need follow-up"** -- returns structured outreach candidates with risk labels

**"Preview this batch of 10 follow-up texts"** -- returns exact recipients, messages, warnings, and an approval token before anything sends

**"Show recent delivery failures"** -- reports outgoing messages that Messages marked failed or pending, including whether a later SMS/RCS send recovered the thread

**"Show me the photo from message 538516"** -- returns the actual image for Claude to view and describe

**"Send 'Running 10 min late' to +1234567890"** -- sends an iMessage (requires confirmation)

## Release Flags

Release flags are opt-in through the MCP server environment:

```json
{
  "mcpServers": {
    "imessage": {
      "command": "node",
      "args": ["/path/to/imessage-mcp/index.js"],
      "env": {
        "IMESSAGE_MCP_RELEASES": "auto_sms_fallback,cleanup_failed_imessage_after_sms_fallback,message_mutation_tools,experimental_message_ui_actions,read_receipts"
      }
    }
  }
}
```

| Flag | Behavior |
|------|----------|
| `auto_sms_fallback` | `send_message` and `send_message_batch` verify recent outgoing rows after an auto iMessage send. If Messages marks the blue bubble failed and the recipient is phone-based, the MCP retries through SMS/RCS. |
| `cleanup_failed_imessage_after_sms_fallback` | After `auto_sms_fallback` successfully retries by SMS/RCS, the MCP makes a best-effort UI cleanup pass to delete the failed blue iMessage bubble and reports whether cleanup was verified. This never mutates `chat.db` directly. |
| `message_mutation_tools` | Exposes `delete_messages` and `delete_threads`. These tools make a timestamped backup of `chat.db`, `chat.db-wal`, and `chat.db-shm` before direct local Messages database cleanup. `delete_messages` deletes exact message row IDs without confirmation. `delete_threads` requires one exact-batch approval token for the full requested chat ID list. |
| `experimental_message_ui_actions` | Exposes `edit_message` and `undo_send_message`. These tools use Messages UI automation, validate that the target is a recent outgoing iMessage, and verify against `chat.db` after the action. They fail clearly when Messages does not expose the menu action or the message is outside Apple's allowed window. |
| `read_receipts` | Adds read receipt fields to structured conversation results and read status hints to `get_conversation` text output. Supports outgoing 1:1 iMessage and RCS rows when macOS has synced `date_read`. SMS, group chats, and inbound messages are reported as unsupported. Missing `date_read` means not read or unavailable, which can also mean receipts are disabled or not synced. |

### Mutation Tools

`delete_messages` accepts exact message ROWIDs:

```json
{ "message_ids": ["538516", "538517"] }
```

It does not require confirmation. It reports deleted IDs, missing IDs, backup location, and any remaining rows found during verification.

`delete_threads` is a two-step exact-batch flow:

```json
{ "chat_ids": [101, 102] }
```

The preview returns one `approval_token` for that ordered list and the thread metadata shown in the preview. To delete, send the same ordered `chat_ids`, `confirm: true`, and that token:

```json
{ "chat_ids": [101, 102], "confirm": true, "approval_token": "..." }
```

Changing the order, list, or token fails the request.

`edit_message` and `undo_send_message` are experimental because Messages does not expose first-class AppleScript commands for those actions. They open the conversation, find the visible outgoing bubble by text snippet, use the contextual menu, then verify the result. They are intended to affect actual Messages behavior, not fake local-only DB edits.

Optional tuning:

```bash
IMESSAGE_MCP_SEND_VERIFY_DELAY_MS=2500
```

This controls how long the MCP waits before checking the local Messages database for the new outgoing row.

## How It Works

### The attributedBody Fix

Apple's iMessage database (`~/Library/Messages/chat.db`) has two columns for message content:

- `text` -- the legacy plain text column (used by older macOS versions)
- `attributedBody` -- a serialized `NSAttributedString` blob (used by macOS 14+)

On modern macOS, Apple gradually migrated message storage to `attributedBody` to support rich text, mentions, and formatting. The `text` column is increasingly just a legacy fallback that's often `NULL`.

This server detects messages with `NULL` text and extracts the content from `attributedBody` by parsing the binary `NSTypedStream` format:

1. Finds the `NSString` marker in the binary blob
2. Reads past the type header bytes (`01 94 84 01 2b`)
3. Decodes the length prefix (single-byte for short messages, multi-byte for longer ones)
4. Extracts the UTF-8 text payload

### Attachment Handling

iMessage attachments are stored in `~/Library/Messages/Attachments/` with paths tracked in the `attachment` table. The `get_attachment` tool:

1. Queries the attachment metadata for a given message ID
2. Resolves the `~/Library/Messages/...` path to an absolute path
3. For JPEG/PNG/GIF/WebP: reads the file and returns base64 image content
4. For HEIC (iPhone default): converts to JPEG using macOS `sips` before returning
5. For other files: returns metadata and the file path

## Troubleshooting

**"Failed to open iMessage database"**
Grant Full Disk Access to your terminal app: System Settings > Privacy & Security > Full Disk Access.

**Contact lookup returns no results**
Contact resolution reads the macOS AddressBook SQLite databases directly (no Contacts app needed). Make sure Full Disk Access is granted. If a contact was just added, restart the MCP server to refresh the cache.

**Native module crash / "NODE_MODULE_VERSION mismatch"**
Rebuild native dependencies: `npm rebuild`. This happens when your Node.js version changes. Also make sure your Claude Desktop config uses the full path to node (see Configuration above).

**Missing messages from a conversation**
This is exactly the bug this server fixes. Make sure you're running the latest version which includes the `attributedBody` extraction.

## License

MIT

## Quickstart TL;DR

```bash
npm install
node index.js
```

Then add the server to your MCP client config and grant Full Disk Access to your terminal app.

## How It Works (TL;DR)

- Reads macOS iMessage SQLite database
- Decodes modern `attributedBody` payloads for complete message text
- Exposes conversation/search/attachment tools via MCP
- Uses AppleScript for message send/reaction actions with explicit confirmations

## LLM Quick Copy

Use the copy button on this code block in GitHub.

```txt
Repo: imessage-mcp
Goal: Full iMessage MCP including attachments and send/reaction actions.
Setup:
1) npm install
2) Grant Full Disk Access to terminal app
3) Add MCP config entry for index.js
Use:
- read_recent_messages, search_messages, get_conversation
- list_chats_structured, get_conversation_by_chat_id, find_outreach_followups
- get_attachment for image/file analysis
- send_message/send_message_batch/react_to_message with explicit confirm flag
How it works:
- SQLite + attributedBody decoding + AppleScript actions wrapped as MCP tools
```
