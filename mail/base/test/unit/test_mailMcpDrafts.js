/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests the mail endpoint's drafts: that createDraft writes the draft the
 * compose window would have -- HTML, signed, with the identity's own copies --
 * and attaches files to it, and that updateDraft changes a draft where it is,
 * keeping what it was not asked to change.
 *
 * Driven over HTTP with a real token, as the MCP bridge calls it.
 */

const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { MailMcpServer, MailMcpTokens } = ChromeUtils.importESModule(
  "resource:///modules/MailMcpServer.sys.mjs"
);
const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
const { mailTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MailTestUtils.sys.mjs"
);
const { MimeParser } = ChromeUtils.importESModule(
  "resource:///modules/mimeParser.sys.mjs"
);

const SIGNATURE = "Mé Example\nExample University <me@example.com>";
const SIGNED =
  '<pre class="moz-signature" cols="72">-- \n' +
  "Mé Example\nExample University &lt;me@example.com&gt;</pre>";

/** Every byte there is, so that an attachment changed in passing shows. */
const BYTES = Uint8Array.from({ length: 512 }, (_, i) => i % 256);

/** The smallest PNG, for a picture set in a draft's text. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA" +
  "60e6kgAAAABJRU5ErkJggg==";

let identity, drafts, trash, inbox, token, dataFile, notesFile, chartFile;

/**
 * One call to the endpoint.
 *
 * @param {string} method
 * @param {object} params
 * @returns {Promise<{result: ?object, error: ?string}>}
 */
async function rpc(method, params) {
  const response = await fetch(`http://127.0.0.1:${MailMcpServer.port}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ method, params }),
  });
  return response.json();
}

/**
 * @param {string} id
 * @returns {nsIMsgDBHdr}
 */
function hdrOf(id) {
  return MailServices.messageServiceFromURI(id).messageURIToMsgHdr(id);
}

/**
 * A saved message taken apart.
 *
 * @param {string} id
 * @returns {{headers: object, parts: object[], html: ?string, text: ?string}}
 *   With each part as {type, headers, bytes}, and the body decoded.
 */
function read(id) {
  const hdr = hdrOf(id);
  const parts = [];
  MimeParser.parseSync(
    mailTestUtils.loadMessageToString(hdr.folder, hdr),
    {
      startPart(number, headers) {
        parts.push({
          number,
          headers,
          type: headers.contentType.type,
          chunks: [],
        });
      },
      deliverPartData(number, data) {
        parts.find(part => part.number == number).chunks.push(data);
      },
    },
    { bodyformat: "decode", strformat: "typedarray", decodeSubMessages: false }
  );
  for (const part of parts) {
    part.bytes = Uint8Array.from(part.chunks.flatMap(chunk => [...chunk]));
  }
  const decoded = type => {
    const part = parts.find(p => p.type == type);
    return part
      ? new TextDecoder().decode(part.bytes).replaceAll("\r\n", "\n")
      : null;
  };
  return {
    headers: parts[0].headers,
    parts,
    html: decoded("text/html"),
    text: decoded("text/plain"),
  };
}

/**
 * @param {string} name
 * @param {Uint8Array|string} content
 * @returns {Promise<string>} The path of a new file holding it.
 */
async function fileHolding(name, content) {
  const path = PathUtils.join(PathUtils.tempDir, `mcpDrafts-${name}`);
  await IOUtils.write(
    path,
    typeof content == "string" ? new TextEncoder().encode(content) : content
  );
  registerCleanupFunction(() => IOUtils.remove(path, { ignoreAbsent: true }));
  return path;
}

/** @returns {number} */
function draftCount() {
  return [...drafts.msgDatabase.enumerateMessages()].length;
}

add_setup(async function () {
  const account = MailServices.accounts.createLocalMailAccount();
  identity = MailServices.accounts.createIdentity();
  identity.email = "me@example.com";
  identity.fullName = "Mé Example";
  identity.doBcc = true;
  identity.doBccList = "me@example.com";
  identity.htmlSigText = SIGNATURE;
  account.addIdentity(identity);

  const root = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  drafts = identity.getOrCreateDraftsFolder();
  trash = root.getFolderWithFlags(Ci.nsMsgFolderFlags.Trash);
  inbox = root
    .createLocalSubfolder("mcpDrafts")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  inbox.addMessage(
    new MessageGenerator()
      .makeMessage({ subject: "Lunch on Friday?" })
      .toMessageString()
  );

  dataFile = await fileHolding("data.bin", BYTES);
  notesFile = await fileHolding("notes.txt", "Bring the figures.\n");
  chartFile = await fileHolding(
    "chart.png",
    Uint8Array.from(atob(PNG), c => c.charCodeAt(0))
  );

  Services.prefs.setBoolPref("mail.compose.default_to_paragraph", true);
  Services.prefs.setBoolPref("mail.mcp.enabled", true);
  // Let the system choose, so the test never meets a running Thunderbird.
  Services.prefs.setIntPref("mail.mcp.port", -1);
  MailMcpServer.start();
  registerCleanupFunction(() => MailMcpServer.stop());
  ({ token } = await MailMcpTokens.create("test"));
});

add_task(async function testADraftIsWrittenAsTheComposeWindowWould() {
  const before = draftCount();
  const { result } = await rpc("createDraft", {
    from: "me@example.com",
    to: "Zoë Bell <zoe@example.com>",
    subject: "Plan – 计划",
    body: "Dear Zoë,\n\nFirst line\n  an <indented> one\n\n\nBest,\nMé\n",
  });
  Assert.ok(result.saved, "it says the draft was saved");
  Assert.equal(result.folder, drafts.URI, "in the identity's Drafts");
  Assert.equal(draftCount(), before + 1, "where there is one more message");

  const hdr = hdrOf(result.id);
  Assert.equal(hdr.folder.URI, drafts.URI, "the id it gives is the draft's");
  Assert.equal(hdr.mime2DecodedSubject, "Plan – 计划");
  Assert.equal(hdr.mime2DecodedRecipients, "Zoë Bell <zoe@example.com>");

  const draft = read(result.id);
  Assert.equal(draft.parts.length, 1, "with no attachment it is one part");
  Assert.equal(draft.parts[0].type, "text/html", "which is HTML");
  Assert.stringContains(draft.html, "<p>Dear Zoë,</p>");
  Assert.stringContains(
    draft.html,
    "<p>First line<br>\n&nbsp;&nbsp;an &lt;indented&gt; one</p>",
    "a line break within a paragraph, and nothing taken for markup"
  );
  Assert.stringContains(draft.html, "<p>Best,<br>\nMé</p>\n" + SIGNED);

  const header = name => draft.headers.getRawHeader(name)?.[0];
  Assert.stringContains(header("x-mozilla-draft-info"), "internal/draft");
  Assert.equal(header("x-identity-key"), identity.key);
  Assert.equal(header("bcc"), "me@example.com", "the identity's own copy");
  Assert.ok(header("message-id"), "it has a Message-ID");
  Assert.stringContains(header("from"), "<me@example.com>");
});

add_task(async function testWithoutParagraphs() {
  Services.prefs.setBoolPref("mail.compose.default_to_paragraph", false);
  const { result } = await rpc("createDraft", {
    from: identity.key,
    body: "One\n\nTwo",
  });
  Services.prefs.setBoolPref("mail.compose.default_to_paragraph", true);
  Assert.stringContains(
    read(result.id).html,
    'One<br>\n<br>\nTwo<br>\n<pre class="moz-signature"'
  );
});

add_task(async function testASignatureWrittenOutIsNotThereTwice() {
  const { result } = await rpc("createDraft", {
    from: "me@example.com",
    body: `See you there.\n\n-- \n${SIGNATURE}\n`,
  });
  const { html } = read(result.id);
  Assert.equal(html.split("Example University").length, 2, "signed once");
  Assert.stringContains(html, "<p>See you there.</p>\n" + SIGNED);
});

add_task(async function testAnIdentityThatWritesPlainText() {
  identity.composeHtml = false;
  const { result } = await rpc("createDraft", {
    from: "me@example.com",
    body: "A line that ends in a space \n indented\n",
  });
  identity.composeHtml = true;

  const draft = read(result.id);
  Assert.equal(draft.parts[0].type, "text/plain");
  Assert.equal(
    draft.text,
    `A line that ends in a space\n  indented\n\n-- \n${SIGNATURE}\n`,
    "flowed text, with the signature set off"
  );
});

add_task(async function testFilesAreAttached() {
  const { result } = await rpc("createDraft", {
    from: "me@example.com",
    subject: "Figures",
    body: "Attached.",
    attachments: [dataFile, { path: notesFile, name: "备注.txt" }],
  });
  Assert.deepEqual(result.attachments, ["mcpDrafts-data.bin", "备注.txt"]);

  const draft = read(result.id);
  Assert.equal(draft.parts[0].type, "multipart/mixed");
  Assert.deepEqual(
    draft.parts.at(-2).bytes,
    BYTES,
    "a file arrives byte for byte"
  );

  const { result: message } = await rpc("getMessage", { id: result.id });
  Assert.deepEqual(
    message.attachments.map(a => a.name),
    ["mcpDrafts-data.bin", "备注.txt"],
    "and is listed, under the name asked for"
  );
  const { result: handed } = await rpc("getAttachment", {
    id: result.id,
    name: "备注.txt",
  });
  Assert.equal(await IOUtils.readUTF8(handed.path), "Bring the figures.\n");
});

add_task(async function testAFileThatCannotBeAttached() {
  const before = draftCount();
  for (const [path, complaint] of [
    [`${dataFile}.missing`, "there is no file at"],
    ["notes.txt", "not the full path"],
    [PathUtils.tempDir, "is not a file"],
  ]) {
    const { error } = await rpc("createDraft", {
      from: "me@example.com",
      body: "Attached.",
      attachments: [path],
    });
    Assert.stringContains(error, complaint, `${path} is refused`);
  }
  Assert.equal(draftCount(), before, "and no draft is saved without it");
});

add_task(async function testADraftIsChangedWhereItIs() {
  const { result: first } = await rpc("createDraft", {
    from: "me@example.com",
    to: "Zoë Bell <zoe@example.com>",
    subject: "Plan – 计划",
    body: "Dear Zoë,\n\nHere is the plan.",
    attachments: [dataFile, notesFile],
  });
  const before = draftCount();
  const was = read(first.id);
  const firstMessageId = hdrOf(first.id).messageId;

  const { result: second } = await rpc("updateDraft", {
    id: first.id,
    cc: "Chairs <chairs@example.com>",
  });
  Assert.equal(second.replaced, first.id);
  Assert.notEqual(second.id, first.id, "the draft is saved again");
  Assert.equal(draftCount(), before, "and there is still only the one");
  Assert.ok(
    [...trash.msgDatabase.enumerateMessages()].some(
      hdr => hdr.messageId == firstMessageId
    ),
    "the version it replaced is in the Trash"
  );
  Assert.notEqual(hdrOf(second.id).messageId, firstMessageId);

  let now = read(second.id);
  const header = name => now.headers.getRawHeader(name)?.[0];
  Assert.equal(header("cc"), "Chairs <chairs@example.com>");
  Assert.equal(hdrOf(second.id).mime2DecodedSubject, "Plan – 计划");
  Assert.equal(
    hdrOf(second.id).mime2DecodedRecipients,
    "Zoë Bell <zoe@example.com>"
  );
  Assert.equal(header("bcc"), "me@example.com");
  Assert.equal(header("x-identity-key"), identity.key);
  Assert.equal(now.html, was.html, "the body is as it was");
  Assert.deepEqual(
    second.attachments,
    ["mcpDrafts-data.bin", "mcpDrafts-notes.txt"],
    "and so are the attachments"
  );
  Assert.deepEqual(now.parts.at(-2).bytes, BYTES, "byte for byte");

  // A new body, sent back with the signature that was read with the old one.
  const { result: third } = await rpc("updateDraft", {
    id: second.id,
    body: `Dear Zoë,\n\nShorter.\n\n-- \n${SIGNATURE}`,
    removeAttachments: ["mcpDrafts-data.bin"],
    attachments: [{ path: dataFile, name: "figures.bin" }],
    to: "",
  });
  Assert.deepEqual(third.attachments, ["mcpDrafts-notes.txt", "figures.bin"]);
  now = read(third.id);
  Assert.stringContains(now.html, "<p>Shorter.</p>\n" + SIGNED);
  Assert.ok(!now.html.includes("Here is the plan"), "the old body has gone");
  Assert.equal(now.html.split("Example University").length, 2, "signed once");
  Assert.ok(!now.headers.has("to"), "a field given empty is cleared");
  Assert.equal(
    now.headers.getRawHeader("cc")[0],
    "Chairs <chairs@example.com>"
  );
  Assert.equal(draftCount(), before);

  const { error } = await rpc("updateDraft", {
    id: third.id,
    removeAttachments: ["nothing.pdf"],
  });
  Assert.stringContains(error, "mcpDrafts-notes.txt, figures.bin");
  Assert.ok(hdrOf(third.id), "a change that cannot be made changes nothing");
});

add_task(async function testOnlyADraftCanBeChanged() {
  const [hdr] = inbox.msgDatabase.enumerateMessages();
  const { error } = await rpc("updateDraft", {
    id: inbox.getUriForMsg(hdr),
    subject: "Changed",
  });
  Assert.stringContains(error, "not in a Drafts folder");
  Assert.equal(
    [...inbox.msgDatabase.enumerateMessages()].length,
    1,
    "a message that is not a draft is left where it is"
  );

  Assert.stringContains(
    (await rpc("updateDraft", { id: "mailbox-message://nobody/x#99" })).error,
    "no draft with id"
  );
});

add_task(async function testAReplyRemembersWhatItAnswers() {
  const [original] = inbox.msgDatabase.enumerateMessages();
  const originalId = inbox.getUriForMsg(original);

  const { result } = await rpc("createDraft", {
    from: "me@example.com",
    inReplyTo: originalId,
    body: "Friday works.",
  });
  Assert.equal(result.subject, "Re: Lunch on Friday?");
  let draft = read(result.id);
  const messageId = `<${original.messageId}>`;
  Assert.equal(draft.headers.getRawHeader("in-reply-to")[0], messageId);
  Assert.equal(draft.headers.getRawHeader("references")[0], messageId);
  Assert.equal(hdrOf(result.id).getStringProperty("origURIs"), originalId);
  Assert.equal(
    hdrOf(result.id).getStringProperty("queuedDisposition"),
    "replied",
    "so that sending it marks the original as answered"
  );

  const { result: changed } = await rpc("updateDraft", {
    id: result.id,
    body: "Friday works, at one.",
  });
  draft = read(changed.id);
  Assert.equal(changed.subject, "Re: Lunch on Friday?");
  Assert.equal(draft.headers.getRawHeader("in-reply-to")[0], messageId);
  Assert.equal(hdrOf(changed.id).getStringProperty("origURIs"), originalId);
  Assert.equal(
    hdrOf(changed.id).getStringProperty("queuedDisposition"),
    "replied"
  );
});

add_task(async function testADraftWrittenAsPlainTextBecomesHtml() {
  // What createDraft used to write.
  drafts.QueryInterface(Ci.nsIMsgLocalMailFolder).addMessage(
    [
      "From: =?UTF-8?B?TcOpIEV4YW1wbGU=?= <me@example.com>",
      "To: zoe@example.com",
      "Subject: =?UTF-8?B?5pen6I2J56i/?=",
      "Date: Fri, 09 Oct 2026 08:00:00 GMT",
      "Message-ID: <older@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "X-Mozilla-Draft-Info: internal/draft",
      "",
      // As bytes, one to a character, which is how a folder takes a message.
      String.fromCharCode(
        ...new TextEncoder().encode("你好，\n\n第一段\n第二行\n")
      ),
    ].join("\r\n")
  );
  const older = [...drafts.msgDatabase.enumerateMessages()].find(
    hdr => hdr.messageId == "older@example.com"
  );

  const { result } = await rpc("updateDraft", {
    id: drafts.getUriForMsg(older),
    cc: "chairs@example.com",
  });
  Assert.equal(result.from, "me@example.com", "the identity it is from");
  Assert.equal(result.subject, "旧草稿");
  const draft = read(result.id);
  Assert.equal(draft.parts[0].type, "text/html");
  Assert.stringContains(draft.html, "<p>你好，</p>\n<p>第一段<br>\n第二行</p>");
  Assert.ok(!draft.html.includes("moz-signature"), "nothing is added to it");
});

add_task(async function testAPictureInTheTextIsKeptWithIt() {
  const html =
    '<html><body><p>The chart: <img src="cid:chart@example.com"></p></body></html>';
  drafts
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .addMessage(
      [
        "From: me@example.com",
        "To: zoe@example.com",
        "Subject: Chart",
        "Date: Fri, 09 Oct 2026 09:00:00 GMT",
        "Message-ID: <chart-draft@example.com>",
        "MIME-Version: 1.0",
        `X-Identity-Key: ${identity.key}`,
        "X-Mozilla-Draft-Info: internal/draft; vcard=0; receipt=1; DSN=0; " +
          "uuencode=0; attachmentreminder=1; deliveryformat=2",
        'Content-Type: multipart/mixed; boundary="mixed"',
        "",
        "--mixed",
        'Content-Type: multipart/related; boundary="related"',
        "",
        "--related",
        "Content-Type: text/html; charset=UTF-8",
        "",
        html,
        "--related",
        'Content-Type: image/png; name="chart.png"',
        "Content-Transfer-Encoding: base64",
        "Content-ID: <chart@example.com>",
        'Content-Disposition: inline; filename="chart.png"',
        "",
        PNG,
        "--related--",
        "",
        "--mixed",
        'Content-Type: text/csv; charset=GBK; name="data.csv"',
        "Content-Transfer-Encoding: base64",
        'Content-Disposition: attachment; filename="data.csv"',
        "",
        btoa("\xc4\xea,2026\r\n"),
        "--mixed--",
        "",
      ].join("\r\n")
    );
  const saved = [...drafts.msgDatabase.enumerateMessages()].find(
    hdr => hdr.messageId == "chart-draft@example.com"
  );

  let { result } = await rpc("updateDraft", {
    id: drafts.getUriForMsg(saved),
    subject: "The chart",
  });
  Assert.deepEqual(result.attachments, ["data.csv"]);
  let draft = read(result.id);
  Assert.deepEqual(
    draft.parts.map(part => part.type),
    [
      "multipart/mixed",
      "multipart/related",
      "text/html",
      "image/png",
      "text/csv",
    ]
  );
  Assert.equal(draft.html.trim(), html, "the text is untouched");
  const picture = draft.parts[3];
  Assert.equal(
    picture.headers.getRawHeader("content-id")[0],
    "<chart@example.com>",
    "and still finds its picture"
  );
  Assert.equal(btoa(String.fromCharCode(...picture.bytes)), PNG);
  Assert.equal(
    String.fromCharCode(...draft.parts[4].bytes),
    "\xc4\xea,2026\r\n",
    "a text attachment keeps the bytes it had, whatever their charset"
  );
  const info = draft.headers.getRawHeader("x-mozilla-draft-info")[0];
  Assert.stringContains(info, "receipt=1;", "what was chosen for it is kept");
  Assert.stringContains(info, "attachmentreminder=1;");
  Assert.stringContains(info, "deliveryformat=2");

  // New text has no place for the picture; the attachment stays.
  ({ result } = await rpc("updateDraft", { id: result.id, body: "No chart." }));
  draft = read(result.id);
  Assert.deepEqual(
    draft.parts.map(part => part.type),
    ["multipart/mixed", "text/html", "text/csv"]
  );
});

add_task(async function testFormattedText() {
  const { result } = await rpc("createDraft", {
    from: "me@example.com",
    subject: "Formatted",
    html:
      '<p onclick="steal()">Dear <b>Zoë</b>, see ' +
      '<a href="https://example.com/plan">the plan</a>.</p>' +
      '<script>steal()</script><form><input name="q"></form>' +
      '<table border="1"><tr><td style="color: red">3 pm</td></tr></table>',
  });
  const draft = read(result.id);
  Assert.equal(draft.parts.length, 1, "it is one part, of HTML");
  Assert.stringContains(
    draft.html,
    '<p>Dear <b>Zoë</b>, see <a href="https://example.com/plan">the plan</a>.</p>',
    "the formatting is kept"
  );
  Assert.stringContains(draft.html, '<td style="color: red">3 pm</td>');
  for (const gone of ["onclick", "<script", "steal", "<form", "<input"]) {
    Assert.ok(!draft.html.includes(gone), `${gone} is not`);
  }
  Assert.stringContains(draft.html, "</table>\n" + SIGNED, "and it is signed");

  const { error } = await rpc("createDraft", {
    from: "me@example.com",
    body: "Plain",
    html: "<p>Formatted</p>",
  });
  Assert.stringContains(error, "not as both");
});

add_task(async function testPicturesInTheText() {
  const { result } = await rpc("createDraft", {
    from: "me@example.com",
    subject: "Chart",
    html:
      `<p>From a file: <img src="${chartFile}" alt="chart"></p>` +
      `<p>Written in: <img src="data:image/png;base64,${PNG}"></p>` +
      '<p>On the web: <img src="https://example.com/x.png"></p>',
  });
  let draft = read(result.id);
  Assert.deepEqual(
    draft.parts.map(part => part.type),
    ["multipart/related", "text/html", "image/png", "image/png"],
    "a picture on this computer, or written into the HTML, is in the message"
  );
  const names = draft.parts
    .slice(2)
    .map(part => part.headers.getRawHeader("content-id")[0].slice(1, -1));
  for (const [index, name] of names.entries()) {
    Assert.stringContains(draft.html, `src="cid:${name}"`, "and shown by name");
    Assert.equal(
      btoa(String.fromCharCode(...draft.parts[2 + index].bytes)),
      PNG
    );
  }
  Assert.stringContains(
    draft.html,
    'src="https://example.com/x.png"',
    "one on the web is left where it is"
  );

  // The way to change formatted text: read its HTML, change it, hand it back.
  const { result: message } = await rpc("getMessage", {
    id: result.id,
    html: true,
  });
  Assert.stringContains(message.html, `src="cid:${names[0]}"`);
  Assert.stringContains(message.html, 'class="moz-signature"');
  Assert.ok(!message.html.includes("<body"), "only what is in the body");

  const { result: changed } = await rpc("updateDraft", {
    id: result.id,
    html: message.html
      .replace("From a file", "<i>From the file</i>")
      .replace(/<p>Written in:.*?<\/p>/s, ""),
  });
  draft = read(changed.id);
  Assert.deepEqual(
    draft.parts.map(part => part.type),
    ["multipart/related", "text/html", "image/png"],
    "the picture still shown is kept, the one taken out is not"
  );
  Assert.equal(
    draft.parts[2].headers.getRawHeader("content-id")[0],
    `<${names[0]}>`
  );
  Assert.stringContains(draft.html, "<i>From the file</i>");
  Assert.equal(draft.html.split("moz-signature").length, 2, "signed once");

  const { error } = await rpc("updateDraft", {
    id: changed.id,
    html: `<p><img src="${notesFile}"></p>`,
  });
  Assert.stringContains(error, "is not a picture");
  Assert.ok(hdrOf(changed.id), "and the draft is as it was");
});

add_task(async function testWhatIsChosenForADraft() {
  const header = (id, name) => read(id).headers.getRawHeader(name)?.[0];
  const { result: plain } = await rpc("createDraft", {
    from: "me@example.com",
    body: "Nothing chosen.",
  });
  Assert.ok(!read(plain.id).headers.has("x-priority"), "no priority unasked");
  Assert.stringContains(
    header(plain.id, "x-mozilla-draft-info"),
    "receipt=0; DSN=0; uuencode=0; attachmentreminder=0; deliveryformat=4",
    "nor anything else"
  );

  const { result } = await rpc("createDraft", {
    from: "me@example.com",
    subject: "Options",
    body: "Please confirm.",
    priority: "High",
    returnReceipt: true,
    deliveryStatusNotification: true,
    deliveryFormat: "both",
    attachmentReminder: true,
  });
  const chosen = id => {
    Assert.equal(header(id, "x-priority"), "2 (High)");
    Assert.stringContains(
      header(id, "x-mozilla-draft-info"),
      "receipt=1; DSN=1; uuencode=0; attachmentreminder=1; deliveryformat=3"
    );
  };
  chosen(result.id);

  const { result: second } = await rpc("updateDraft", {
    id: result.id,
    cc: "chairs@example.com",
  });
  chosen(second.id);

  const { result: third } = await rpc("updateDraft", {
    id: second.id,
    priority: "normal",
    returnReceipt: false,
  });
  Assert.ok(!read(third.id).headers.has("x-priority"), "normal is none");
  Assert.stringContains(
    header(third.id, "x-mozilla-draft-info"),
    "receipt=0; DSN=1; uuencode=0; attachmentreminder=1; deliveryformat=3",
    "what was not mentioned is as it was"
  );

  const { error } = await rpc("updateDraft", {
    id: third.id,
    priority: "urgent",
  });
  Assert.stringContains(error, "highest, high, normal, low, lowest");
});
