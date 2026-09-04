/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests that starring an IMAP message tags it Important.
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

let hdr;

const keywords = () => hdr.getStringProperty("keywords") ?? "";

add_setup(async function () {
  Services.prefs.setBoolPref("mail.startagsync.reconciled", true);
  setupIMAPPump();

  const generator = new MessageGenerator();
  const message = generator.makeMessage();
  IMAPPump.mailbox.addMessage(
    new ImapMessage(
      Services.io
        .newURI(`data:text/plain;base64,${btoa(message.toMessageString())}`)
        .spec,
      IMAPPump.mailbox.uidnext++,
      []
    )
  );

  const listener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.updateFolderWithListener(null, listener);
  await listener.promise;

  hdr = [...IMAPPump.inbox.msgDatabase.enumerateMessages()][0];
  Assert.ok(hdr, "the message arrived");

  StarTagSync.start();
  registerCleanupFunction(() => StarTagSync.stop());
});

add_task(async function testStarringAnImapMessageTagsIt() {
  Assert.ok(!keywords().includes(IMPORTANT), "it starts untagged");

  IMAPPump.inbox.markMessagesFlagged([hdr], true);

  await TestUtils.waitForCondition(
    () => keywords().includes(IMPORTANT),
    "starring an IMAP message should tag it Important"
  );
});

add_task(function endTest() {
  teardownIMAPPump();
});
