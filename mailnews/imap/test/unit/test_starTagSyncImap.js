/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests that starring an IMAP message tags it Important -- whether the star is
 * set here or arrives from the server, having been set on another device.
 *
 * It works on a local folder, so if it is going wrong in practice it is
 * going wrong here: an IMAP flag change is applied locally and confirmed by
 * the server afterwards, and the notification the sync listens for is not
 * obviously the same one on both paths.
 */

/* import-globals-from head_server.js */

const { StarTagSync } = ChromeUtils.importESModule(
  "resource:///modules/StarTagSync.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

const IMPORTANT = "$label1";
const generator = new MessageGenerator();

let secondFolder;

const isStarred = hdr => Boolean(hdr.flags & Ci.nsMsgMessageFlags.Marked);
const isTagged = hdr =>
  (hdr.getStringProperty("keywords") ?? "").split(/\s+/).includes(IMPORTANT);
const headerFor = synth =>
  IMAPPump.inbox.msgDatabase.getMsgHdrForMessageID(synth.messageId);

async function update(folder) {
  const listener = new PromiseTestUtils.PromiseUrlListener();
  folder.updateFolderWithListener(null, listener);
  await listener.promise;
}

/**
 * Put a message on the server, the way another client would.
 *
 * @param {string[]} flags - IMAP flags it carries from the start.
 */
function addServerMessage(flags) {
  const synth = generator.makeMessage();
  const msg = new ImapMessage(
    `data:text/plain;base64,${btoa(synth.toMessageString())}`,
    IMAPPump.mailbox.uidnext++,
    []
  );
  // Not through the constructor: it walks its flags with for...in, so what it
  // stores is each flag's index rather than the flag.
  for (const flag of flags) {
    msg.setFlag(flag);
  }
  IMAPPump.mailbox.addMessage(msg);
  return { msg, synth };
}

/**
 * Select another folder and then the inbox again. The fake server allows one
 * connection, so this is what makes the inbox's flags be fetched afresh --
 * the way a change made on a phone is discovered.
 */
async function resyncInbox() {
  await update(secondFolder);
  await update(IMAPPump.inbox);
}

add_setup(async function () {
  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );
  setupIMAPPump();
  IMAPPump.daemon.createMailbox("secondFolder", { subscribed: true });

  addServerMessage([]);
  await update(IMAPPump.inbox);
  secondFolder = IMAPPump.incomingServer.rootFolder
    .getChildNamed("secondFolder")
    .QueryInterface(Ci.nsIMsgImapMailFolder);

  StarTagSync.start();
  registerCleanupFunction(() => StarTagSync.stop());
});

add_task(async function testStarringAnImapMessageTagsIt() {
  const hdr = [...IMAPPump.inbox.msgDatabase.enumerateMessages()][0];
  Assert.ok(!isTagged(hdr), "it starts untagged");

  IMAPPump.inbox.markMessagesFlagged([hdr], true);

  await TestUtils.waitForCondition(
    () => isTagged(hdr),
    "starring an IMAP message should tag it Important"
  );
});

add_task(async function testAStarFromTheServerTagsIt() {
  const { msg, synth } = addServerMessage([]);
  await resyncInbox();
  Assert.ok(!isStarred(headerFor(synth)), "it arrives unstarred");

  msg.setFlag("\\Flagged");
  await resyncInbox();
  Assert.ok(isStarred(headerFor(synth)), "the star comes over from the server");

  await TestUtils.waitForCondition(
    () => isTagged(headerFor(synth)),
    "a star set on another device should tag it Important"
  );
});

add_task(async function testReadAndStarredElsewhereTagsIt() {
  // Opening a message on a phone and flagging it: both reach here together.
  const { msg, synth } = addServerMessage([]);
  await resyncInbox();

  msg.setFlag("\\Seen");
  msg.setFlag("\\Flagged");
  await resyncInbox();
  Assert.ok(isStarred(headerFor(synth)), "the star comes over from the server");

  await TestUtils.waitForCondition(
    () => isTagged(headerFor(synth)),
    "a message read and starred elsewhere should be tagged Important"
  );
});

add_task(async function testAMessageThatArrivesStarredIsTagged() {
  // Flagged on a phone before this client had seen it at all.
  const { synth } = addServerMessage(["\\Flagged"]);
  await resyncInbox();
  Assert.ok(isStarred(headerFor(synth)), "it arrives starred");

  await TestUtils.waitForCondition(
    () => isTagged(headerFor(synth)),
    "a message that arrives already starred should be tagged Important"
  );
});

add_task(function endTest() {
  teardownIMAPPump();
});
