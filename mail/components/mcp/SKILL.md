---
name: thunderbird-mail
description: Read the user's Thunderbird mailbox and draft replies. Use for any question about their mail — what someone said, what a thread decided, what is unanswered, what is attached — and to draft a reply or a new message. Requires Thunderbird to be running.
---

# Working with the user's mailbox

Six tools: `search_mail`, `get_message`, `get_thread`, `list_folders`,
`list_identities`, `create_draft`.

You can read mail and save drafts. You cannot send, move, delete or flag
anything — so a draft is always the end of the line, and the user sends it.

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
{"headers": {"list-id": "ntcir"}, "folder": "INBOX"}
```

- `from`, `to`, `subject` are case-insensitive substrings, so `liu` matches
  both `Yiqun Liu` and `yiqunliu@example.com`. Prefer a surname or the
  distinctive part of an address over a full formatted name.
- **A query is optional, but then `folder` is required.** "Everything from her
  this month" is a folder read with filters, not a search.
- Dates are ISO: `2026-08-01`, or a full timestamp.
- `$label1` is Important, `$label2` Work, `$label3` Personal, `$label4`
  To Do, `$label5` Later. In this mailbox Important also tracks the star, and
  `$mailflagbit0/1/2` are Apple Mail's coloured flags.
- `limit` defaults to 25, maximum 200.

If a search returns nothing, widen before giving up: drop a filter, shorten
the query, try a synonym the sender would have used. If it returns hundreds,
add a date range rather than reading them all.

## Reading

`get_message` gives the decoded body and the attachment list — names, types
and sizes. You cannot open an attachment's contents; say what is attached and
let the user open it.

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
- **A draft is not confirmed within 45 seconds.** Saving to IMAP is a round
  trip to the server. Tell the user it may still have arrived, and to check
  Drafts rather than drafting it again.
