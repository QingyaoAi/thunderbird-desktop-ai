---
name: thunderbird-mail
description: Read the user's Thunderbird mailbox and draft replies. Use when the task is about their mail — what someone said, what a thread decided, what is unanswered, what is attached — or the user says what it needs came by email, and to draft a reply or a new message. Not for finding background to work on files or documents that the user did not say is in their mail. Requires Thunderbird to be running.
---

# Working with the user's mailbox

Eight tools: `search_mail`, `get_message`, `get_attachment`, `get_thread`,
`list_folders`, `list_identities`, `create_draft`, `update_draft`.

You can read mail, read its attachments, and save and change drafts. You
cannot send, move, delete or flag anything — so a draft is always the end of
the line, and the user sends it.

## When to look

Look in the mailbox when the task is about mail, or when the user says
something came by email or asks you to check. Work on a document, a form,
slides or a spreadsheet is not by itself a reason to search their mail for
instructions, comments or people's details they did not mention. Work from
what they gave you, and if something is missing, ask where it is rather than
searching the mailbox on a guess — which also reads mail the task never
needed (see Privacy).

## The shape of a good answer

**Search, then read.** Search returns headers and a 300-character snippet.
The snippet is for choosing what to open, never for answering from. Open the
message before you state what it says.

**Read the thread, not the message.** A single message is half a
conversation. When the answer depends on what was decided, agreed or
promised, call `get_thread` — the reply that matters is usually not the one
that matched the search.

**Quote and attribute.** Say who said it and when: "Junjie confirmed on
9 August that the deadline is 1 September." Vague summaries of someone's mail
are worse than useless, because they cannot be checked.

**Say when you did not find it.** An empty search is a real answer. Do not
fill the gap with what the mail probably says.

## Searching well

`query` is full text, ranked as Thunderbird's own search ranks it. Everything
else narrows.

Start broad, then filter. A two- or three-word query finds more than a
sentence, because it is matched as terms rather than as a phrase.

```json
{"query": "conference budget"}
{"query": "budget", "from": "hoshino", "after": "2026-06-01"}
{"folder": "INBOX", "from": "chen", "after": "2026-08-01"}
{"query": "invoice", "hasAttachment": true}
{"query": "review", "tag": "$label1"}
{"query": "acceptance letter", "sort": "date"}
{"headers": {"list-id": "ntcir"}, "folder": "INBOX"}
```

**"Latest", "most recent", "this week": sort by date.** A text search is
ranked by relevance, and a common phrase has hundreds of matches, so the
newest can fall past `limit`. Pass `"sort": "date"` (newest first) or add
`after`. A folder read with no query is always newest first.

- `from`, `to`, `subject` are case-insensitive substrings, so `liu` matches
  both `Yiqun Liu` and `yiqunliu@example.com`. Prefer a surname or the
  distinctive part of an address over a full formatted name.
- **A query is optional, but then `folder` is required.** "Everything from her
  this month" is a folder read with filters, not a search.
- Dates are ISO: `2026-08-01`, or a full timestamp.
- `$label1` is Important, `$label2` Work, `$label3` Personal, `$label4`
  To Do, `$label5` Later. In this mailbox Important also tracks the star, and
  `$mailflagbit0/1/2` are Apple Mail's coloured flags.
- `sort` is `relevance` (the default) or `date`, for text searches.
- `limit` defaults to 25, maximum 200.

If a search returns nothing, widen before giving up: drop a filter, shorten
the query, try a synonym the sender would have used. If it returns hundreds,
add a date range rather than reading them all.

## Reading

`get_message` gives the decoded body and the attachment list — each with an
`index`, name, type and size.

`get_attachment` fetches one of them: pass the message id and the
attachment's `index` (or its `name`; with a single attachment, neither). It
returns a `path` to a private temporary file, which you read like any other
file — PDFs and images included. The file is deleted ten minutes after it was
last asked for (`expires` says when); if you come back to it later, call
`get_attachment` again rather than reusing the old path.

Open an attachment only when the question is about what is in it:
attachments are often the most private thing in a message, and "what did she
send?" is answered by the list, not the contents. Attachments over 50MB, and
ones that were detached or are only links, are refused; say so rather than
guessing what they contain.

`get_thread` takes any id in a conversation and returns all of it, oldest
first. Pass `includeBodies: false` when you only need the shape of the thread
— who replied and when — which is much faster on a long one.

Bodies are capped at 100,000 characters; `truncated: true` means there is
more that you have not seen, and you should say so rather than concluding
from a partial message.

## Drafting

Check `list_identities` first when the user has more than one address, and
pick the one the thread is addressed to. Guessing wrong sends a reply from
the wrong person.

To reply, pass `inReplyTo` with the message id — the reply headers and the
`Re:` subject are filled in, so the draft threads correctly in the client.

```json
{"inReplyTo": "<id from a search result>",
 "body": "Dear Junjie,\n\nThank you — 1 September works.\n\nBest,\nQingyao"}
```

Write it as the user would: their language, their salutation, their sign-off,
which you can see in their own messages in the thread. Match the register of
the thread rather than defaulting to formal English.

`body` is plain text with a blank line between paragraphs — no Markdown. The
draft is saved in the format the user writes mail in, and their signature
and the addresses they always copy are added, as in a message they began
themselves. So stop at the sign-off ("Best, Qingyao"): do not write out the
signature block you see under their other mail.

When the text needs formatting — bold, colour, a list, a link, a table —
give `html` instead of `body`: just what goes in the body, not a whole page,
and again without the signature. Markdown is not formatting here; it arrives
as asterisks. To set a picture in the text, name the file by its full path in
an `<img>`.

```json
{"to": "Junjie Chen <junjie@example.com>", "subject": "Schedule",
 "html": "<p>Dear Junjie,</p><p>The session is <b>Day 2, 09:30</b>:</p><table border=\"1\"><tr><th>Slot</th><th>Talk</th></tr><tr><td>09:30</td><td>Overview</td></tr></table><p><img src=\"/Users/me/Documents/room-map.png\"></p><p>Best,<br>Qingyao</p>"}
```

Whatever the compose window's Options menu sets can be set too: `priority`
(`highest`, `high`, `normal`, `low`, `lowest`), `returnReceipt`,
`deliveryStatusNotification`, `deliveryFormat` (`auto`, `plain`, `html`,
`both`), `attachmentReminder` and `attachVCard`. Set them only when asked;
left out, a new draft gets what the user's own new messages get.

To attach files, pass `attachments` with their full paths. A file from
another message is attached the same way: fetch it with `get_attachment` and
pass the `path` that returns.

```json
{"to": "Junjie Chen <junjie@example.com>", "subject": "Session plan template",
 "body": "Dear Junjie,\n\nThe template is attached.\n\nBest,\nQingyao",
 "attachments": ["/Users/me/Documents/SessionPlan.xlsx"]}
```

`create_draft` returns the draft's `id`. Link the draft with it when you tell
the user about it, and keep it: **to change a draft, call `update_draft` with
that id — never write a second draft and leave the first.** Pass only what is
to change; the rest stays as it was, the body and attachments included.

```json
{"id": "<the draft's id>", "cc": "pc-chairs@example.org"}
{"id": "<the draft's id>", "body": "Dear Junjie,\n\nShorter.\n\nBest,\nQingyao"}
{"id": "<the draft's id>", "attachments": ["/Users/me/Documents/Program.xlsx"],
 "removeAttachments": ["SessionPlan.xlsx"]}
```

A changed draft is saved again, so `update_draft` returns a **new id** — use
that one from then on — and the version it replaced goes to the Trash. It
works on any message in a Drafts folder, one the user wrote included, so
"add them in cc on my draft" is an `update_draft`, not a new draft.

Everything `create_draft` sets, `update_draft` can change: the same `body` or
`html`, and the same options (`{"id": "…", "priority": "high"}`).

New text replaces all of the draft's text. **To change part of a draft and
keep the rest of its formatting, read the HTML first**: `get_message` with
`"html": true` returns the body as `html`, signature and pictures included.
Change what was asked in that HTML and pass all of it back as `html`. Leave
its `cid:` picture addresses and its `moz-signature` block as they are — that
is how the pictures and the signature are kept. Rewriting it as plain `body`
instead would flatten the user's formatting and drop their pictures.

```json
{"id": "<the draft's id>", "html": true}
{"id": "<the draft's id>", "html": "<p>Dear Junjie,</p><p>The session moves to <b>10:30</b>.</p>…the rest as read…"}
```

Do not invent commitments, dates or figures. If the reply needs a fact you do
not have, leave a clearly marked gap for the user to fill rather than a
plausible guess.

Always tell the user a draft was saved and where, and that nothing was sent.

## Privacy

This is somebody's entire mailbox, including things they have not thought
about in years. Read what the task needs and no more. Do not go looking
through unrelated correspondence because it might be interesting, do not
repeat what you found in one thread while answering about another, and quote
only what the answer rests on.

## When it does not work

- **All requests refused.** The password was deleted or is from another
  profile. Ask the user for a new one: Tools → Mail Access for AI.
- **Nothing is listening.** Thunderbird is closed, or access is off in that
  menu. On a large mailbox it takes a couple of minutes after launch.
- **A draft is not confirmed saved in time.** Saving to IMAP is a round
  trip to the server, longer with large attachments. Tell the user it may
  still have arrived, and to check Drafts rather than drafting it again.
- **A draft comes back with no `id`.** It is saved; its folder had not shown
  it yet. Find it with a search of the Drafts folder before changing it.
