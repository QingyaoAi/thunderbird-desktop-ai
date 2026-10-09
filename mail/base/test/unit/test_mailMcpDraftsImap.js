/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests the mail endpoint's drafts in a folder on an IMAP server, where
 * saving is a round trip and the new message is known only once the server
 * has said so: that createDraft comes back with the draft's id, that the
 * draft can be read back and changed by it, and that changing it leaves one
 * draft, with the earlier version in the Trash.
 *
 * Once against a server that reports the key of a message it is given
 * (UIDPLUS), and once against one that does not.
 */

const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { MailMcpServer, MailMcpTokens } = ChromeUtils.importESModule(
  "resource:///modules/MailMcpServer.sys.mjs"
);
const { IMAPPump, setupIMAPPump, teardownIMAPPump } =
  ChromeUtils.importESModule(
    "resource://testing-common/mailnews/IMAPpump.sys.mjs"
  );
const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);
const { setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

let token, notesFile;

/**
 * One call to the endpoint.
 *
 * @param {string} method
 * @param {object} params
 * @returns {Promise<object>} What it answered with.
 */
async function rpc(method, params) {
  const response = await fetch(`http://127.0.0.1:${MailMcpServer.port}/rpc`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ method, params }),
  });
  const { result, error } = await response.json();
  Assert.ok(!error, `${method} is done${error ? `: ${error}` : ""}`);
  return result;
}

/**
 * @param {nsIMsgFolder} folder
 * @returns {Promise<nsIMsgDBHdr[]>} What the server now has in it.
 */
async function messagesIn(folder) {
  // A folder asked to update while it is still busy -- as it is for a moment
  // after a draft is saved to it -- drops the request without a word, so it
  // is asked until it answers.
  for (let answered = false; !answered; ) {
    const listener = new PromiseTestUtils.PromiseUrlListener();
    folder
      .QueryInterface(Ci.nsIMsgImapMailFolder)
      .updateFolderWithListener(null, listener);
    answered = await Promise.race([
      listener.promise.then(() => true),
      // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
      new Promise(resolve => setTimeout(resolve, 500, false)),
    ]);
  }
  return [...folder.messages].filter(
    hdr => !(hdr.flags & Ci.nsMsgMessageFlags.IMAPDeleted)
  );
}

/**
 * Write a draft and change it, on a server of the given kind.
 *
 * @param {string} extensions - What the server can do beyond the basics.
 */
async function writeAndChangeADraft(extensions) {
  setupIMAPPump(extensions);
  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );
  const root = IMAPPump.incomingServer.rootFolder;
  root.createSubfolder("Drafts", null);
  await PromiseTestUtils.promiseFolderAdded("Drafts");
  const drafts = root.getChildNamed("Drafts");
  const trash = root.getChildNamed("Trash");
  Assert.deepEqual(await messagesIn(drafts), [], "no draft to begin with");

  const identity = MailServices.accounts.getFirstIdentityForServer(
    IMAPPump.incomingServer
  );
  identity.email = "me@example.com";
  identity.fullName = "Mé Example";
  identity.draftsFolderURI = drafts.URI;

  const first = await rpc("createDraft", {
    from: "me@example.com",
    to: "Zoë Bell <zoe@example.com>",
    subject: "Plan – 计划",
    body: "Dear Zoë,\n\nHere is the plan.",
    attachments: [notesFile],
  });
  Assert.ok(first.id, "the draft's id is known as soon as it is saved");
  Assert.ok(first.id.startsWith("imap-message://"), "and is the draft's own");
  let saved = await messagesIn(drafts);
  Assert.equal(saved.length, 1, "one draft is on the server");
  Assert.equal(drafts.getUriForMsg(saved[0]), first.id);

  let message = await rpc("getMessage", { id: first.id });
  Assert.equal(message.subject, "Plan – 计划");
  Assert.stringContains(message.body, "Here is the plan.");
  Assert.deepEqual(
    message.attachments.map(a => a.name),
    ["mcpDraftsImap-notes.txt"]
  );

  const second = await rpc("updateDraft", {
    id: first.id,
    cc: "chairs@example.com",
  });
  Assert.ok(second.id, "the changed draft's id is known too");
  Assert.notEqual(second.id, first.id);
  saved = await messagesIn(drafts);
  Assert.equal(saved.length, 1, "there is still one draft");
  Assert.equal(drafts.getUriForMsg(saved[0]), second.id, "the changed one");
  Assert.equal(
    (await messagesIn(trash)).length,
    1,
    "and the version it replaced is in the Trash"
  );

  message = await rpc("getMessage", { id: second.id });
  Assert.equal(message.ccList, "chairs@example.com");
  Assert.equal(message.subject, "Plan – 计划");
  Assert.equal(message.recipients, "Zoë Bell <zoe@example.com>");
  Assert.stringContains(message.body, "Here is the plan.");
  const handed = await rpc("getAttachment", { id: second.id });
  Assert.equal(
    await IOUtils.readUTF8(handed.path),
    "Bring the figures.\n",
    "with its attachment, fetched from the earlier version and sent again"
  );

  teardownIMAPPump();
}

add_setup(async function () {
  notesFile = PathUtils.join(PathUtils.tempDir, "mcpDraftsImap-notes.txt");
  await IOUtils.writeUTF8(notesFile, "Bring the figures.\n");
  registerCleanupFunction(() =>
    IOUtils.remove(notesFile, { ignoreAbsent: true })
  );

  Services.prefs.setBoolPref("mail.mcp.enabled", true);
  // Let the system choose, so the test never meets a running Thunderbird.
  Services.prefs.setIntPref("mail.mcp.port", -1);
  MailMcpServer.start();
  token = MailMcpTokens.createEphemeral();
  registerCleanupFunction(() => {
    MailMcpTokens.revokeEphemeral(token);
    MailMcpServer.stop();
  });
});

add_task(async function testOnAServerThatReportsTheKey() {
  // With MOVE, as the fake server's UIDPLUS cannot answer a COPY.
  await writeAndChangeADraft("MOVE,RFC4315");
});

add_task(async function testOnAServerThatDoesNot() {
  await writeAndChangeADraft("RFC2195");
});
