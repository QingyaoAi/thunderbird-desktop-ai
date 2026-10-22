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
const { setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

/**
 * Let time pass. The waits here are the point: they outlast the sync's
 * settling and its check after a change, to see that nothing more happens.
 *
 * @param {number} ms
 */
function waitOut(ms) {
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  return new Promise(resolve => setTimeout(resolve, ms));
}

const IMPORTANT = "$label1";

let folder, hdr;

const keywords = () => hdr.getStringProperty("keywords") ?? "";
const starred = () => Boolean(hdr.flags & Ci.nsMsgMessageFlags.Marked);

add_setup(async function () {
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

/**
 * A keyword set on IMAP is a queued command, not a local edit: it can fail
 * or be dropped, and when it was the message stayed starred and untagged
 * with nothing watching. Four of two thousand had ended up that way on the
 * profile this was found on.
 */
add_task(async function testAChangeThatDoesNotTakeIsRetried() {
  // A real transition, which is what schedules the check that follows it.
  folder.markMessagesFlagged([hdr], false);
  await TestUtils.waitForCondition(
    () => !starred() && !keywords().includes(IMPORTANT),
    "cleared to begin with"
  );
  folder.markMessagesFlagged([hdr], true);
  await TestUtils.waitForCondition(
    () => keywords().includes(IMPORTANT),
    "starred and tagged"
  );

  // Now take the tag off behind the sync's back, the way a dropped IMAP
  // command leaves it: starred, untagged, and no notification saying so.
  hdr.setStringProperty("keywords", "");
  Assert.ok(starred(), "still starred");
  Assert.ok(!keywords().includes(IMPORTANT), "but the tag is gone");

  // Nothing further is asked for. Only the check scheduled by the star above
  // can put it right, and it is the whole point of this test that it does.
  await TestUtils.waitForCondition(
    () => keywords().includes(IMPORTANT),
    "the check after a change should notice and put the tag back",
    60,
    200
  );
});

/**
 * Start from a message neither starred nor tagged, once the sync has settled
 * that. A check still due from an earlier test acts only on a star and tag
 * that disagree, so it does not need waiting out.
 */
async function startUnstarred() {
  folder.markMessagesFlagged([hdr], false);
  folder.removeKeywordsFromMessages([hdr], IMPORTANT);
  await waitOut(2000);
  Assert.ok(!starred() && !keywords().includes(IMPORTANT), "neither to begin");
}

/**
 * Long enough for a change to settle and for the check after it to have run.
 */
const SETTLE_AND_CHECK_MS = 7000;

/**
 * Record each star and Important tag change to the message from now on.
 *
 * @returns {string[]} "star on", "tag off" and so on, filled in as they come.
 */
function recordChanges() {
  const changes = [];
  const listener = {
    onFolderPropertyFlagChanged(msg, property, oldFlag, newFlag) {
      if (msg.messageKey == hdr.messageKey && property == "Flagged") {
        changes.push(
          newFlag & Ci.nsMsgMessageFlags.Marked ? "star on" : "star off"
        );
      }
    },
    msgPropertyChanged(msg, property, oldValue, newValue) {
      if (msg.messageKey == hdr.messageKey && property == "keywords") {
        changes.push(newValue.includes(IMPORTANT) ? "tag on" : "tag off");
      }
    },
    QueryInterface: ChromeUtils.generateQI([
      "nsIFolderListener",
      "nsIMsgFolderListener",
    ]),
  };
  MailServices.mailSession.AddFolderListener(
    listener,
    Ci.nsIFolderListener.propertyFlagChanged
  );
  MailServices.mfn.addListener(listener, MailServices.mfn.msgPropertyChanged);
  registerCleanupFunction(() => {
    MailServices.mailSession.RemoveFolderListener(listener);
    MailServices.mfn.removeListener(listener);
  });
  return changes;
}

/**
 * The flag lists an IMAP server sends back can predate the star they answer,
 * and each is written onto the header as it comes: the star goes off for a
 * moment and comes back with the next one. That moment was taken for an
 * unstar, and a Gmail star flickered off and on and ended up off.
 */
add_task(async function testAStarBrieflyTakenBackStays() {
  await startUnstarred();
  folder.markMessagesFlagged([hdr], true);
  // What nsImapMailFolder::NotifyMessageFlags does with a stale flag list
  // and then a fresh one.
  folder.msgDatabase.markMarked(hdr.messageKey, false, null);
  folder.msgDatabase.markMarked(hdr.messageKey, true, null);

  const changes = recordChanges();
  await waitOut(SETTLE_AND_CHECK_MS);
  Assert.ok(starred(), "still starred");
  Assert.ok(keywords().includes(IMPORTANT), "and tagged");
  Assert.deepEqual(changes, ["tag on"], "with nothing taken back on the way");
});

/**
 * Starring by mistake and unstarring at once leaves neither, and the check
 * after the first change does not put the star back.
 */
add_task(async function testAStarUndoneAtOnceStaysUndone() {
  await startUnstarred();
  folder.markMessagesFlagged([hdr], true);
  folder.markMessagesFlagged([hdr], false);

  const changes = recordChanges();
  await waitOut(SETTLE_AND_CHECK_MS);
  Assert.ok(!starred(), "unstarred");
  Assert.ok(!keywords().includes(IMPORTANT), "and untagged");
  Assert.deepEqual(changes, [], "with nothing coming back later");
});

/**
 * The pass over existing mail is what repairs messages a gap left out of step,
 * so it has to run again when a gap is closed -- once, not on every launch.
 */
add_task(async function testThePassRunsOncePerVersion() {
  const isTagged = h =>
    (h.getStringProperty("keywords") ?? "").split(/\s+/).includes(IMPORTANT);
  const addStarredBehindTheSyncsBack = () => {
    const before = new Set(
      [...folder.msgDatabase.enumerateMessages()].map(h => h.messageKey)
    );
    folder.addMessage(new MessageGenerator().makeMessage().toMessageString());
    const added = [...folder.msgDatabase.enumerateMessages()].find(
      h => !before.has(h.messageKey)
    );
    // Straight onto the header, which reports nothing: how a star that came
    // in through one of the gaps looks afterwards.
    added.orFlags(Ci.nsMsgMessageFlags.Marked);
    Assert.ok(!isTagged(added), "starred and untagged to begin with");
    return added;
  };

  const missed = addStarredBehindTheSyncsBack();
  Services.prefs.setIntPref("mail.startagsync.reconciledVersion", 1);
  await StarTagSync.reconcileOnce();
  Assert.ok(isTagged(missed), "a pass that is due should tag what it finds");
  Assert.greater(
    Services.prefs.getIntPref("mail.startagsync.reconciledVersion"),
    1,
    "and record that it has run"
  );

  const later = addStarredBehindTheSyncsBack();
  await StarTagSync.reconcileOnce();
  Assert.ok(!isTagged(later), "a pass that has already run should not run again");
});
