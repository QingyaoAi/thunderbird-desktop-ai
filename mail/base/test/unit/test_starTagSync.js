/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests that starring a message tags it Important, and the other way about.
 */

const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
const { StarTagSync } = ChromeUtils.importESModule(
  "resource:///modules/StarTagSync.sys.mjs"
);
const { TagMessageCounts } = ChromeUtils.importESModule(
  "resource:///modules/TagMessageCounts.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

const IMPORTANT = "$label1";

let folder, hdr;

const keywords = () => hdr.getStringProperty("keywords") ?? "";
const starred = () => Boolean(hdr.flags & Ci.nsMsgMessageFlags.Marked);

add_setup(async function () {
  // The one-off reconcile is not what is being tested, and it walks every
  // folder in the profile.
  Services.prefs.setBoolPref("mail.startagsync.reconciled", true);

  const account = MailServices.accounts.createLocalMailAccount();
  const root = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  folder = root
    .createLocalSubfolder("stars")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  folder.addMessage(new MessageGenerator().makeMessage().toMessageString());
  hdr = [...folder.msgDatabase.enumerateMessages()][0];

  StarTagSync.start();
  registerCleanupFunction(() => StarTagSync.stop());
});

add_task(async function testStarringTags() {
  Assert.ok(!starred(), "the message starts unstarred");
  Assert.ok(!keywords().includes(IMPORTANT), "and untagged");

  folder.markMessagesFlagged([hdr], true);

  await TestUtils.waitForCondition(
    () => keywords().includes(IMPORTANT),
    "starring a message should tag it Important"
  );
});

add_task(async function testUnstarringUntags() {
  folder.markMessagesFlagged([hdr], false);

  await TestUtils.waitForCondition(
    () => !keywords().includes(IMPORTANT),
    "unstarring should take the tag off again"
  );
});

add_task(async function testTaggingStars() {
  folder.addKeywordsToMessages([hdr], IMPORTANT);

  await TestUtils.waitForCondition(
    () => starred(),
    "tagging a message Important should star it"
  );
});

/**
 * The other half of what a star is meant to do: show up in the count beside
 * the Important row in the folder pane.
 */
add_task(async function testTheTagIsCounted() {
  TagMessageCounts.start();
  registerCleanupFunction(() => TagMessageCounts.stop());
  await TagMessageCounts.refresh();

  const before = TagMessageCounts.get(IMPORTANT);

  // Leave it starred for the count to find.
  folder.markMessagesFlagged([hdr], false);
  await TestUtils.waitForCondition(
    () => !keywords().includes(IMPORTANT),
    "cleared before counting"
  );
  Assert.equal(
    TagMessageCounts.get(IMPORTANT),
    Math.max(0, before - 1),
    "removing the tag is counted"
  );

  folder.markMessagesFlagged([hdr], true);
  await TestUtils.waitForCondition(
    () => keywords().includes(IMPORTANT),
    "starring tags it again"
  );

  await TestUtils.waitForCondition(
    () => TagMessageCounts.get(IMPORTANT) > 0,
    "a message tagged by starring should be counted under Important"
  );
});
