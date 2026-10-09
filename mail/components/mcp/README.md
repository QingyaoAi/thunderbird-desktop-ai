# Mail access for AI

A local endpoint that lets an AI assistant read this Thunderbird's mail and
write drafts, plus a bridge that presents it to MCP clients.

It reads mail, writes drafts and tags messages. There is no method that
sends anything, or that moves or deletes a message — the worst outcome of a
confused model is a draft nobody sent, or a tag to take off again. The one
thing it removes is the version of a draft it was asked to change, and that
goes to the Trash.

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
- **Read, draft and tag only.** Nothing sends, and no message is moved or
  deleted. A draft can be changed, which saves it again and puts the version
  it replaces in the Trash; only a message in a Drafts folder can be. Tags
  can be added and taken off, and Important is the star, so that one stars
  and unstars; a tag is never created, only chosen from the user's own.
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
| `getMessage` | One message: headers, decoded body, attachment list; its HTML if asked |
| `getAttachment` | One attachment, written to a private temporary file |
| `getThread` | Every message in a conversation, oldest first |
| `listFolders` | Folders with message and unread counts |
| `listIdentities` | Addresses this Thunderbird can write as |
| `createDraft` | Save a draft; never sends |
| `updateDraft` | Change a draft where it is; never sends |
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

`getMessage` with `html: true` also returns the body as `html` — what is in
the body, as the message has it, with pictures set in the text named by
their `cid:` addresses; `null` for a message whose text is not HTML. It is
capped the same way, with `htmlTruncated: true`, and is there for changing a
draft and keeping its formatting (see `updateDraft`).

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

`to`, `cc`, `bcc`, `subject`, `body` or `html`, `from` (an address from
`listIdentities`; the default identity otherwise), `replyTo`, `inReplyTo`
— a message id, which fills in `In-Reply-To`, `References` and a `Re:`
subject — and `attachments`, a list of files on this computer by full path
(or `{path, name}` to attach one under another name; 50MB in all). The draft
lands in that identity's Drafts folder. Nothing is sent.

What the compose window's Options menu sets is set with `priority`
(`highest`, `high`, `normal`, `low`, `lowest`), `returnReceipt`,
`deliveryStatusNotification`, `deliveryFormat` (`auto`, `plain`, `html`,
`both`), `attachmentReminder` and `attachVCard`. Left out, they are what the
identity gives a new message.

`html` is the text with its formatting, in place of `body`: what goes in the
body rather than a whole page. Scripts, event handlers and forms are taken
out of it; styles, tables, links and the rest stay. A picture whose `src` is
a file's full path, a `file:` URL or a `data:` URL is made part of the
message and shown from there, as one pasted into the compose window is; one
on the web is left where it is.

The draft is the one the compose window would have saved, built by the same
code: `body` is plain text and is saved as HTML where the identity writes
HTML — paragraphs or line breaks, as `mail.compose.default_to_paragraph` has
it — with the identity's signature after it and its automatic Cc, Bcc and
Reply-To filled in. So it opens in the editor the user writes in, as the
identity it was written as. A reply also remembers the message it answers,
which is marked as answered when the draft is sent.

Returns `id`, the draft's own id, along with `folder`, `subject`, `from` and
the names of its `attachments`.

### `updateDraft`

`id`, and any of what `createDraft` takes but `inReplyTo` — `attachments`
being files to add — plus `removeAttachments` (names to take off). What is
not given stays as it was — the text exactly, with any pictures set in it,
the attachments byte for byte, and what was chosen in the Options menu — and
a field given as an empty string is cleared.

New text replaces the whole text. To change part of a formatted draft, read
it with `getMessage` and `html: true`, change that HTML and give it back as
`html`: the pictures it still shows are kept, by the `cid:` addresses it
shows them with, and it is not signed a second time while its signature
block is in it.

A message on a server cannot be edited, so the draft is saved again and the
earlier version deleted, as the compose window does on a second save: the
result carries the new `id`, and the old one as `replaced`. The earlier
version is deleted only once the new one is confirmed saved, and goes to the
Trash rather than for good. Only a message in a Drafts folder can be changed,
which is what keeps this from deleting anything else; that includes a draft
the user wrote. An encrypted draft is refused.

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

It offers all ten tools, the tagging ones included. The stdio bridge keeps
its own list of the first eight, so a client started through it cannot tag.

`mcp-endpoint.json` records this URL as `mcpUrl`.

## The AI panel's dsh mode

The **dsh** button in the AI panel's header runs
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as an
agent the panel talks to. Where dsh is installed it is on from the start: the
panel opens with dsh as what answers, and the button turns it off, for the
panel's own model to answer instead. Whichever the button left it as is what
the panel next opens with. Where there is no dsh to run -- node or dsh not
found, or mail access off -- the panel opens with its own model, as before.

On is not running. The program is started by the first thing sent to it, or
by pressing the button when it is off, so a Thunderbird nobody asks anything
has no dsh process and leaves no empty session. Starting it runs
`dsh --profile acp` — the Agent Client Protocol, JSON-RPC over the program's
stdin and stdout — and opens a session with this mailbox attached as an MCP
server on `/mcp`. The token for that is made in memory for the run and dropped
when the run ends; it is never stored and never appears among the passwords
above. While dsh is on, what is typed in the panel goes to it, together with
the message that is open, if any: a link whose target is the message's id and
whose name gives its subject, sender and date.

dsh is started with a patch layer of Thunderbird's own
(`dsh-thunderbird.patch.yml` in the profile, rewritten each time) in place of
its ACP profile's coding-agent persona. It says to start from what is open:
when a request could be about the open message, read that message's whole
conversation with `get_thread` first and answer from it; look in the rest of
the mailbox only for what the conversation does not settle, with a few
searches and no more; and when the open conversation has nothing to do with
the request, or nothing is open, do the task by searching the mailbox, turning
to the web, the shell or files only when the mail does not answer it. Only
that run is affected; dsh started any other way is not.

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
**Clear** starts a new session; pressing **dsh** while it is on stops the
program.

The **⚙** beside it sets the three paths. They, and how the button was left,
are kept in these prefs:

| Pref | What | When unset |
| --- | --- | --- |
| `mail.ai.dsh.on` | Whether the button left dsh on | On |
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

**A draft is not confirmed saved in time.** Saving to IMAP is a round trip
— 45 seconds are allowed, and more for large attachments, up to five
minutes; the error says so rather than hanging, and the draft may still
arrive. A draft being changed keeps its earlier version in that case.
