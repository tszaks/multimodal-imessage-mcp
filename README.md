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
| `get_attachment` | **View images and files** from messages -- Claude can see and analyze photos |
| `send_message` | Send iMessages (with confirmation safety) |
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
- **Node.js** >= 18
- **Full Disk Access** granted to your terminal app (System Settings > Privacy & Security > Full Disk Access). This covers both the iMessage database and the AddressBook database used for contact name resolution — no need to have the Contacts app running.

## Installation

```bash
git clone https://github.com/tyszakacs/multimodal-imessage-mcp.git
cd multimodal-imessage-mcp
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
      "args": ["/path/to/multimodal-imessage-mcp/index.js"]
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
      "args": ["/path/to/multimodal-imessage-mcp/index.js"]
    }
  }
}
```

> In Claude Code, `node` typically resolves correctly since it inherits your shell environment.

## Usage Examples

**"Show me my recent messages"** -- reads your latest conversations

**"What did Mom text me today?"** -- resolves "Mom" to a phone number via your AddressBook, pulls the conversation

**"Search my messages for 'flight confirmation'"** -- full-text search across all messages

**"Show me the photo from message 538516"** -- returns the actual image for Claude to view and describe

**"Send 'Running 10 min late' to +1234567890"** -- sends an iMessage (requires confirmation)

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
