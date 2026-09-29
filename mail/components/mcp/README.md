# Mail access for AI

A local endpoint that lets an AI assistant read this Thunderbird's mail and
write drafts, plus a bridge that presents it to MCP clients.

It reads mail, writes drafts and tags messages. There is no method that
sends, moves or deletes anything — the worst outcome of a confused model is a
draft nobody sent, or a tag to take off again.

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

### With Claude Code

`install-claude-skill.sh` puts `SKILL.md` where Claude Code looks for skills
and points a stdio MCP server at the bridge, in one step:

```bash
curl -fsSL https://raw.githubusercontent.com/QingyaoAi/thunderbird-desktop-ai/main/mail/components/mcp/install-claude-skill.sh \
  | bash -s -- <the password>
```

Run it with no password to install just the skill and print the
`claude mcp add` command to run once you have made one. It requires `node`
and the `claude` CLI on `PATH`, and needs no checkout of this repository —
it downloads the two files it needs. Re-running it is safe; it replaces any
existing `thunderbird` MCP server registration.

## Security

- **Loopback only.** The socket binds `127.0.0.1`, and a connection from
  anywhere else is dropped before it is read.
- **Every request needs the password**, in `Authorization: Bearer <token>`.
  A missing, malformed or wrong one gets the same `401` and the same words,
  so nothing is learned from the difference. Comparison is constant-time.
- **Passwords live with the mail passwords** — encrypted at rest, covered by
  the primary password if one is set. Never in a config file, never in the
  repository.
- **Read, draft and tag only.** Nothing sends, moves or deletes. Tags can be
  added and taken off, and Important is the star, so that one stars and
  unstars; a tag is never created, only chosen from the user's own.
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
| `getAttachment` | One attachment, written to a private temporary file |
| `getThread` | Every message in a conversation, oldest first |
| `listFolders` | Folders with message and unread counts |
| `listIdentities` | Addresses this Thunderbird can write as |
| `createDraft` | Save a draft; never sends |
| `listTags` | The user's tags: key, name and colour |
| `tagMessages` | Add tags to messages, or take them off |

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
| `sort` | `relevance` (default: Gloda's ranking, newest first among ties) or `date` (newest first) |
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

### `getAttachment`

Takes the message `id` and either the attachment's `index` from
`getMessage`'s list or its `name` (neither, if there is only one). Thunderbird
fetches the part the way it does when an attachment is opened, writes it to
`mcp-attachments` in the profile's cache directory -- readable by this user
only, and outside what backups copy -- and returns
`{id, index, name, contentType, size, path, expires}`.

The file is deleted ten minutes after it was last asked for, which is long
enough to read a long document a few pages at a time; asking again returns
the same file and resets the clock, and asking after it has gone fetches it
again. The directory is also emptied when access is turned off, when
Thunderbird quits, and when the endpoint starts, which catches anything a
crash left behind. `mail.mcp.attachments.lifetime_seconds` changes the ten
minutes.

Only a part stored in the message is served. A message can mark an attachment
as detached and point it at a `file://` path, or make it a link, in part
headers any sender can write; following those would let an email choose which
local file or URL this reads, so they are refused. So are attachments over
50MB. `mail.mcp.attachments.enabled` set to `false` turns the method off while
leaving the rest of the endpoint on.

### `createDraft`

`to`, `cc`, `bcc`, `subject`, `body`, `from` (an address from
`listIdentities`; the default identity otherwise), `replyTo`, and `inReplyTo`
— a message id, which fills in `In-Reply-To`, `References` and a `Re:`
subject. The draft lands in that identity's Drafts folder. Nothing is sent.

### `tagMessages`

`ids` (message ids from a search, at most 500), and `add` and/or `remove`,
each a list of tags by key or by the name the user sees, case-insensitive. A
name that is not one of the user's tags is refused, with the list of tags it
could have been; nothing is created. Returns each message as it now is.

## MCP over HTTP

`/mcp` speaks MCP itself, over Streamable HTTP, for a client that can be given
a URL rather than a program to start: `POST` one JSON-RPC message (or, from
older clients, a list of them) with the same `Authorization` header, and the
answer comes back as a plain JSON body — never an event stream. A
notification is answered `202` with no body. There are no sessions, and a
`GET` to open a stream of the server's own is answered `405`, which the
protocol has clients take in their stride.

It offers all nine tools, the tagging ones included. The stdio bridge keeps
its own list of the first seven, so a client started through it cannot tag.

`mcp-endpoint.json` records this URL as `mcpUrl`.

## The AI panel's dsh mode

The **dsh** button in the AI panel's header runs
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as an
agent the panel talks to. It is off until pressed, and nothing about it runs
until then. Pressing it starts `dsh --profile acp` — the Agent Client
Protocol, JSON-RPC over the program's stdin and stdout — and opens a session
with this mailbox attached as an MCP server on `/mcp`. The token for that is
made in memory for the run and dropped when the run ends; it is never stored
and never appears among the passwords above. While dsh is on, what is typed in
the panel goes to it, together with the message that is open, if any, as a
link it can read with `get_message`.

dsh is started with a patch layer of Thunderbird's own
(`dsh-thunderbird.patch.yml` in the profile, rewritten each time) in place of
its ACP profile's coding-agent persona: whatever the task, look in the mailbox
first, and turn to the web, the shell or files only when the mail does not
answer it. Only that run is affected; dsh started any other way is not.

Answers link the messages they cite. The persona asks for `[text](<id>)`
whenever an answer mentions a message -- a message's id is its URI -- and the
panel shows such a link with an envelope, opens the message in the mail tab
when it is clicked, and strikes it through if the message is not there. As a
fallback, the panel remembers the subject and id of every message the mail
tools return in a session, and links an answer's exact mention of such a
subject that the model left unlinked. (The endpoint's MCP `instructions` say
the same thing about links, for clients that use them; dsh does not, for a
server its client attaches.)

dsh keeps its own model settings and keys, and the panel offers its models in
place of its own. It can run commands and read and write files in its working
folder; when it asks permission to use a tool, the panel shows the request,
with a choice to allow everything for the rest of the session. Pressing
**Clear** starts a new session; pressing **dsh** again stops the program.

The **⚙** beside it sets the three paths, kept in these prefs:

| Pref | What | When unset |
| --- | --- | --- |
| `mail.ai.dsh.node` | node | The first of `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/usr/bin/node` that exists |
| `mail.ai.dsh.path` | dsh: its `apps/cli/lib/bin.js`, run with node, or an installed `dsh` program | The first `dsh` found in node's folder, `/opt/homebrew/bin` or `/usr/local/bin` -- where `npm install -g` puts it |
| `mail.ai.dsh.workspace` | The folder dsh works in | `thunderbird-dsh` in the temporary folder |

dsh keeps each session it runs under `~/.dsh` (or `$DSH_HOME`): a log in
`sessions/`, filed by working folder, and a cache in
`storages/session_projcache/`. Thunderbird records the id of every session it
starts, in `dsh-sessions.json` in the profile, and the **⚙** menu can delete
those -- log and cache -- by id. The session in use is kept, and a session
started in dsh itself is never touched, even in the same working folder.

Thunderbird started from the Dock has only the system `PATH`, so dsh is
started with node's folder, `/opt/homebrew/bin` and `/usr/local/bin` in front
of it. Mail access must be on (Tools → Mail Access for AI…), since that is how
dsh reads the mail.

## Troubleshooting

**Nothing is listening.** Check the menu says access is on, and give a large
profile a couple of minutes after launch.

**The bridge cannot find the endpoint.** It looks for `mcp-endpoint.json` in
the profile. Set `MAIL_MCP_URL` to override.

**Everything returns 401.** The password was deleted, or belongs to another
profile. Make a new one.

**A draft is not confirmed within 45 seconds.** Saving to IMAP is a round
trip; the error says so rather than hanging, and the draft may still arrive.
