# Mail access for AI

A local endpoint that lets an AI assistant read this Thunderbird's mail and
write drafts, plus a bridge that presents it to MCP clients.

It reads mail and writes drafts. There is no method that sends, moves,
deletes or marks anything — the worst outcome of a confused model is a draft
nobody sent.

## Why it lives inside Thunderbird

An external process could open `global-messages-db.sqlite` directly, but the
useful parts of Thunderbird are its own APIs:

- **Gloda** ranks a search the way the search box does. Reimplementing that
  against the schema means a different, worse answer to the same query.
- **`MsgHdrToMimeMessage`** decodes a body and lists attachments. The
  database holds indexed text, not messages.
- **`nsIMsgDBHdr`** carries tags, flags, folders and thread structure.

The cost of that choice: Thunderbird must be running.

## Setting it up

1. **Tools → Mail Access for AI…** — shows whether access is on, how many
   passwords exist, and offers: turn access on/off, create a password, show
   stored passwords, delete one, delete all.
2. **Create a password.** It is shown once, in a field you can copy from, and
   is put on the clipboard. Afterwards only its label and date can be listed.
3. **Point a client at the bridge:**

   ```json
   {
     "mcpServers": {
       "thunderbird": {
         "command": "node",
         "args": ["<repo>/comm/mail/components/mcp/mail-mcp-bridge.js"],
         "env": { "MAIL_MCP_TOKEN": "<the password>" }
       }
     }
   }
   ```

The endpoint listens on **127.0.0.1:47821**. If that port is taken the system
picks another and records it in `mcp-endpoint.json` in the profile, which the
bridge reads, so a client keeps working either way.

On a large profile the listener starts a couple of minutes after launch: it
runs as an idle task, behind the work of opening the mail itself.

## Security

- **Loopback only.** The socket binds `127.0.0.1`, and a connection from
  anywhere else is dropped before it is read.
- **Every request needs the password**, in `Authorization: Bearer <token>`.
  A missing, malformed or wrong one gets the same `401` and the same words,
  so nothing is learned from the difference. Comparison is constant-time.
- **Passwords live with the mail passwords** — encrypted at rest, covered by
  the primary password if one is set. Never in a config file, never in the
  repository.
- **Read and draft only.** Nothing sends, moves, deletes or flags.
- Access can be turned off entirely from the same menu, and passwords deleted
  individually or all at once. Deletion takes effect on the next request.

What this does *not* protect against: any program running as you on this
machine can reach the port, and needs only the password to read all your
mail. Treat a password like a mail password — and if one is pasted into a
chat, delete it and make another.

## The wire format

`POST /rpc`, `Authorization: Bearer <token>`, JSON in and out:

```json
{ "method": "search", "params": { "query": "invoice", "limit": 5 } }
```

Answers are `{"result": …}` or `{"error": "…"}`. Status is `200`, `401` for a
bad password, `404` for an unknown method, `400` for unparseable JSON.

```bash
curl -s -X POST http://127.0.0.1:47821/rpc \
  -H "Authorization: Bearer $MAIL_MCP_TOKEN" \
  -d '{"method":"listFolders"}'
```

## Methods

| Method | Purpose |
| --- | --- |
| `search` | Ranked full-text search, with filters |
| `getMessage` | One message: headers, decoded body, attachment list |
| `getThread` | Every message in a conversation, oldest first |
| `listFolders` | Folders with message and unread counts |
| `listIdentities` | Addresses this Thunderbird can write as |
| `createDraft` | Save a draft; never sends |

### `search`

`query` is full text, ranked by Gloda. The filters narrow it; with no query,
`folder` is required and the folder is read directly — which is how "all mail
from her since March" is answered without inventing search terms.

| Field | Meaning |
| --- | --- |
| `query` | Full-text terms |
| `from`, `to`, `subject` | Substring, case-insensitive, on the decoded field |
| `folder` | Folder name or URI |
| `after`, `before` | ISO dates |
| `tag` | Tag key, e.g. `$label1` (Important) |
| `unread`, `flagged`, `hasAttachment` | Booleans |
| `headers` | `{"list-id": "ntcir"}` — any header, by name |
| `limit` | Default 25, maximum 200 |

`headers` costs differ: `subject`, `from`, `to`, `cc`, `bcc`, `message-id`,
`references` and `keywords` are already in the database and are free.
Anything else is read from the message itself, so it runs last, on what the
other filters left, and stops after 300 reads rather than walking a mailbox.

Bad input is refused by name — a date that will not parse, a folder that
matches nothing — rather than quietly ignored.

### `getMessage` / `getThread`

Take an `id` from a search result. `includeBody` / `includeBodies` may be
`false` to skip the body, which is much faster for a long thread. Bodies are
capped at 100,000 characters, with `truncated: true` when cut.

### `createDraft`

`to`, `cc`, `bcc`, `subject`, `body`, `from` (an address from
`listIdentities`; the default identity otherwise), `replyTo`, and `inReplyTo`
— a message id, which fills in `In-Reply-To`, `References` and a `Re:`
subject. The draft lands in that identity's Drafts folder. Nothing is sent.

## Troubleshooting

**Nothing is listening.** Check the menu says access is on, and give a large
profile a couple of minutes after launch.

**The bridge cannot find the endpoint.** It looks for `mcp-endpoint.json` in
the profile. Set `MAIL_MCP_URL` to override.

**Everything returns 401.** The password was deleted, or belongs to another
profile. Make a new one.

**A draft is not confirmed within 45 seconds.** Saving to IMAP is a round
trip; the error says so rather than hanging, and the draft may still arrive.
