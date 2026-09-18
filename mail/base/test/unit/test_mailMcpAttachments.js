/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests the mail endpoint's getAttachment: that it writes out an attachment
 * stored in a message, and refuses one a message only points at.
 *
 * Driven over HTTP with a real token, the way the MCP bridge calls it, so the
 * listener, the token check and the JSON on the wire are covered as well.
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

const NOTES = "The figures for Q3 are in.\nRevenue is up.\n";

let folder, token;

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
 * @param {string} subject
 * @returns {string} The id the endpoint uses for the message.
 */
function idOf(subject) {
  const hdr = [...folder.msgDatabase.enumerateMessages()].find(
    h => h.mime2DecodedSubject == subject
  );
  return folder.getUriForMsg(hdr);
}

add_setup(async function () {
  const account = MailServices.accounts.createLocalMailAccount();
  const root = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  folder = root
    .createLocalSubfolder("attachments")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);

  const generator = new MessageGenerator();
  folder.addMessage(
    generator
      .makeMessage({
        subject: "Quarterly notes",
        attachments: [
          { filename: "notes.txt", body: NOTES, contentType: "text/plain" },
          { filename: "copy.txt", body: NOTES, contentType: "text/plain" },
        ],
      })
      .toMessageString()
  );

  folder.addMessage(
    generator.makeMessage({ subject: "No attachments" }).toMessageString()
  );

  // A part that says it was detached to a file on disk. Any sender can write
  // these headers; serving the part would read whatever file they name.
  folder.addMessage(
    [
      "From: someone@example.com",
      "To: me@example.com",
      "Subject: Detached",
      "Date: Thu, 17 Sep 2026 10:00:00 +0000",
      "Message-ID: <detached@example.com>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="part"',
      "",
      "--part",
      "Content-Type: text/plain",
      "",
      "See attached.",
      "--part",
      'Content-Type: text/plain; name="hosts"',
      'Content-Disposition: attachment; filename="hosts"',
      "X-Mozilla-External-Attachment-URL: file:///etc/hosts",
      'X-Mozilla-Altered: AttachmentDetached; date="Thu Sep 17 10:00:00 2026"',
      "",
      "You deleted an attachment from this message.",
      "--part--",
      "",
    ].join("\r\n")
  );

  Services.prefs.setBoolPref("mail.mcp.enabled", true);
  // Let the system choose, so the test never meets a running Thunderbird.
  Services.prefs.setIntPref("mail.mcp.port", -1);
  MailMcpServer.start();
  registerCleanupFunction(() => MailMcpServer.stop());
  ({ token } = await MailMcpTokens.create("test"));
});

add_task(async function testTheListCarriesAnIndex() {
  const { result } = await rpc("getMessage", { id: idOf("Quarterly notes") });
  Assert.deepEqual(
    result.attachments.map(a => [a.index, a.name]),
    [
      [0, "notes.txt"],
      [1, "copy.txt"],
    ],
    "each attachment is listed with the index get_attachment takes"
  );
});

add_task(async function testAnAttachmentIsWrittenOut() {
  const { result, error } = await rpc("getAttachment", {
    id: idOf("Quarterly notes"),
    index: 0,
  });
  Assert.ok(!error, `no error: ${error}`);
  Assert.equal(result.name, "notes.txt");
  Assert.ok(result.path.endsWith("notes.txt"), "the file keeps its name");

  const text = await IOUtils.readUTF8(result.path);
  Assert.equal(
    text.replace(/\r\n/g, "\n"),
    NOTES,
    "the file holds the attachment"
  );
  Assert.equal(result.size, (await IOUtils.stat(result.path)).size);

  const { permissions } = await IOUtils.stat(result.path);
  Assert.equal(
    permissions & 0o077,
    0,
    "nobody but this user can read the file"
  );

  const again = await rpc("getAttachment", {
    id: idOf("Quarterly notes"),
    name: "notes.txt",
  });
  Assert.equal(
    again.result.path,
    result.path,
    "asking again, by name, returns the same file"
  );
});

add_task(async function testAnUnclearRequestSaysWhatThereIs() {
  const { error } = await rpc("getAttachment", {
    id: idOf("Quarterly notes"),
  });
  Assert.stringContains(error, "0: notes.txt", "the attachments are named");
  Assert.stringContains(error, "1: copy.txt");

  const missing = await rpc("getAttachment", {
    id: idOf("Quarterly notes"),
    name: "budget.xlsx",
  });
  Assert.stringContains(missing.error, 'no attachment named "budget.xlsx"');

  const none = await rpc("getAttachment", { id: idOf("No attachments") });
  Assert.equal(none.error, "the message has no attachments");
});

add_task(async function testADetachedPartIsRefused() {
  const { result, error } = await rpc("getAttachment", {
    id: idOf("Detached"),
    name: "hosts",
  });
  Assert.ok(!result, "nothing is served");
  Assert.stringContains(
    error,
    "not stored in the message",
    "a part that points at a local file is refused"
  );
});

add_task(async function testItCanBeTurnedOff() {
  Services.prefs.setBoolPref("mail.mcp.attachments.enabled", false);
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref("mail.mcp.attachments.enabled")
  );
  const { error } = await rpc("getAttachment", {
    id: idOf("Quarterly notes"),
    index: 0,
  });
  Assert.stringContains(error, "attachment access is turned off");

  const { result } = await rpc("getMessage", { id: idOf("Quarterly notes") });
  Assert.ok(result.body, "the rest of the endpoint stays on");
});
