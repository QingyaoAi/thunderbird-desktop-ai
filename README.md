# Thunderbird (AI fork)

A personal fork of [Thunderbird](https://github.com/thunderbird/thunderbird-desktop)
that adds an AI assistant to the mail window, alongside some changes to how
threads, search and the message list behave.

Everything below the "Upstream Thunderbird" heading is unchanged from
upstream, including the build instructions.

## The AI pane

A fourth pane in the mail tab, next to the message pane. It is shown by
default and can be resized by dragging, or closed from **View → Layout →
AI Assistant**.

**Ask about your mail.** A question is answered from your own messages.
The model writes a search query first (a question makes a poor query on
its own), searches with Thunderbird's own full-text index, and may search
a second time if the first attempt looks thin. Whole conversations are
retrieved rather than single messages, so the exchange can be read in
context. Answers cite the conversations they came from, and clicking a
citation opens the message.

**Draft a reply.** With a thread selected, one click reads the whole
thread and opens a normal compose window with a proposed reply in it. It
never sends anything: the draft is there to be edited.

**Reasoning is shown while it happens.** Models that think before
answering stream that thinking into the panel, which folds itself away
when the answer starts. The search reports each step as it runs, so a
slow question shows what it is doing.

### Configuring a provider

Settings live in `ai-config.json` in your profile folder, written with
defaults on first run:

```json
{
  "activeProfile": "default",
  "profiles": {
    "default": {
      "label": "My provider",
      "format": "openai",
      "baseUrl": "https://api.example.com",
      "model": "your-model",
      "maxTokens": 2048
    }
  },
  "context": {
    "maxMessages": 12,
    "maxThreads": 6,
    "maxCharsPerMessage": 2500,
    "maxTotalChars": 60000
  }
}
```

`format` is `openai` or `anthropic` and describes the endpoint's request
shape, not the vendor. Any endpoint speaking either shape works, including
a local one, which keeps your mail on your machine.

The API key is **not** in this file. Click the key button in the panel
header and it is stored in Thunderbird's login manager, encrypted at rest
and covered by your primary password. `ai-config.json` is gitignored, and
a pre-commit hook rejects anything that looks like an API key.

### Privacy

Retrieved message text is sent to whichever endpoint you configure. The
panel stays inert until a provider and key exist, so nothing is sent
before you set one up, and each answer lists exactly which conversations
were used. Point `baseUrl` at a local model if you would rather nothing
left the machine.

## Mail access for AI assistants (MCP)

An assistant running outside Thunderbird — Claude Code, Claude Desktop, or
anything else that speaks MCP — can search this mailbox, read messages and
threads, and save drafts. It cannot send, move, delete or flag anything.

Two pieces, both in [`mail/components/mcp/`](mail/components/mcp/):

- **[README.md](mail/components/mcp/README.md)** — the endpoint: setup, the
  security model, every method and field.
- **[SKILL.md](mail/components/mcp/SKILL.md)** — written for the assistant:
  how to search well, when to read a whole thread, how to draft as the user.

### 1. Create a password in Thunderbird

**Tools → Mail Access for AI…** → *Create a new password*. It is shown once
and copied to your clipboard. The same menu turns access on or off and
deletes passwords.

The endpoint listens on `127.0.0.1:47821` — loopback only, and every request
must carry a password. On a large mailbox it starts a couple of minutes
after launch.

### 2. Register the MCP server

**Claude Code** — from the checkout:

```bash
claude mcp add thunderbird \
  --env MAIL_MCP_TOKEN=<the password> \
  -- node "$PWD/mail/components/mcp/mail-mcp-bridge.js"
```

**Claude Desktop** — in `claude_desktop_config.json`
(`~/Library/Application Support/Claude/` on macOS):

```json
{
  "mcpServers": {
    "thunderbird": {
      "command": "node",
      "args": ["/absolute/path/to/mail/components/mcp/mail-mcp-bridge.js"],
      "env": { "MAIL_MCP_TOKEN": "<the password>" }
    }
  }
}
```

**Anything else**: the bridge is a stdio MCP server. Run it with
`MAIL_MCP_TOKEN` set and speak JSON-RPC on stdin and stdout. It needs Node
and nothing else — no dependencies to install. Set `MAIL_MCP_URL` if you want
to point it somewhere other than the port recorded in the profile.

### 3. Install the skill

The tools work without it, but the skill is what makes the assistant use them
well rather than mechanically.

**Claude Code** — as a personal skill:

```bash
mkdir -p ~/.claude/skills/thunderbird-mail
cp mail/components/mcp/SKILL.md ~/.claude/skills/thunderbird-mail/SKILL.md
```

Use `.claude/skills/` inside a project instead to scope it to that project.

**Other harnesses**: `SKILL.md` is plain Markdown with YAML frontmatter
giving its name and description. Paste it wherever that harness keeps system
instructions, or hand it over as a document at the start of a session.

### Check it works

With Thunderbird running:

```bash
curl -s -X POST http://127.0.0.1:47821/rpc \
  -H "Authorization: Bearer <the password>" \
  -d '{"method":"listFolders"}'
```

Folders and counts mean the endpoint and password are good, and anything left
is the client's configuration. `401` means the password is wrong or was
deleted; no answer at all means Thunderbird is closed or access is off.

## Other changes

- **VIP folders.** Mark senders as VIPs (right-click a message → *Add
  Sender to VIPs*) to get a folder per person plus a combined one, in the
  same spirit as macOS Mail. Enable via the folder pane's **Folder Modes**
  menu.
- **Message previews.** Each row in the message list shows a line of body
  text.
- **Threads read newest-first**, flattened by date rather than nested by
  reply structure, and a collapsed thread shows the newest message's date
  rather than the thread's first.
- **Field-scoped search.** `subject:`, `from:`, `to:`, `cc:`, `body:` and
  `attachment:` prefixes work in Search Messages.
- **Search results open in the message list**, so clicking a result
  previews it in the reading pane.
- Default UI font size of 16px.

## Building

Identical to upstream: this repository is the `comm/` directory of a
[Firefox checkout](https://github.com/mozilla-firefox/firefox). See
[Building Thunderbird](https://developer.thunderbird.net/thunderbird-development/building-thunderbird).

The AI code is deliberately in new files (`mail/modules/AI*.sys.mjs`,
`mail/base/content/widgets/ai-panel*`) with only small edits to existing
ones, to keep merging from upstream manageable.

---

# Upstream Thunderbird

Thunderbird is a powerful and customizable open source email client with many users. It is based on the same platform that Firefox uses.

## Getting Started
This README will try and give you the basics that you need to get started, more comprehensive documentation is available on the [Thunderbird Developer Website](https://developer.thunderbird.net).

We also have documentation from this repository in a rendered version at [Thunderbird Source Tree Documentation](https://source-docs.thunderbird.net/en/latest/).

### Mozilla Code Base
Thunderbird is built on the Mozilla platform, the same base that Firefox is built from. As such, the two projects share a lot of code and much of the documentation for one will apply to the other.

In order to be able to build Thunderbird - you will need the [Firefox repository](https://github.com/mozilla-firefox/firefox) as well as the [Thunderbird repository](https://github.com/thunderbird/thunderbird-desktop) (where this README lives). Check out our [Getting Started documentation](https://developer.thunderbird.net/thunderbird-development/getting-started) for instructions on how and where to get the source code.

### Firefox vs Thunderbird Source Code
The Firefox repository contains the Firefox codebase and all of the platform code. The Thunderbird repository is added as a subdirectory "comm/" under Firefox. This contains the code for Thunderbird.

## Building Thunderbird
Follow the [Building Thunderbird guide](https://developer.thunderbird.net/thunderbird-development/building-thunderbird) to get set up and build Thunderbird.

## Contributing

### Getting Plugged into the Community
We have a complete listing of the ways in which you can get involved with Thunderbird [on our website](https://thunderbird.net/participate). Below are some quick references from that page that you can use if you are looking to contribute to Thunderbird core right away.

#### Mailing Lists
If you want to participate in discussions about Thunderbird development, there are two main mailing lists you want to join.

1. [**Thunderbird Planning**](https://thunderbird.topicbox.com/groups/planning)**:** This moderated mailing list is for higher level topics like: the future of Thunderbird, potential features, and changes that you would like to see happen. It is also used to discuss a variety of broader issues around community and governance of the project.
2. [**Thunderbird Developers**](https://thunderbird.topicbox.com/groups/developers)**:** A moderated mailing list for discussing engineering plans for Thunderbird. It is a place where you can raise questions and ideas for core Thunderbird development.

#### Matrix Chat
If you want to ask questions about how to hack on Thunderbird, the Matrix room you want to join is [\#maildev:mozilla.org](https://matrix.to/#/#maildev:mozilla.org?web-instance%5Belement.io%5D=chat.mozilla.org).

### Report a Bug and Request Features
Thunderbird uses [Bugzilla](https://bugzilla.mozilla.org/enter_bug.cgi?product=Thunderbird) for reporting and tracking bugs. If you want to become a contributor to Thunderbird, you will need an account on Bugzilla.

Feature requests should be submitted to [Mozilla Connect](https://connect.mozilla.org/).

### Fixing a Bug and Submitting Patches
See [Fixing a Bug in the developer documentation](https://developer.thunderbird.net/thunderbird-development/fixing-a-bug).
