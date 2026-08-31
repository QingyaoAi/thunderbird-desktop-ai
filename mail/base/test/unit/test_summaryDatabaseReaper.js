/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests that the reaper hands back the folder summaries nothing is reading,
 * and leaves alone the ones something still is.
 */

const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
const { SummaryDatabaseReaper } = ChromeUtils.importESModule(
  "resource:///modules/SummaryDatabaseReaper.sys.mjs"
);

const generator = new MessageGenerator();

let inbox, archive;

/**
 * Wait past the millisecond a summary was opened in.
 *
 * lastUseTime is in microseconds and the sweep's cutoff comes from
 * Date.now(), which is not -- so a summary opened part-way through the
 * current millisecond reads as used *after* a cutoff of "now", and a test
 * that opens one and immediately sweeps for idle summaries races the clock.
 * Production never notices: it means only that a summary touched this
 * millisecond survives this sweep, which is what a reaper should do anyway.
 */
function tick() {
  return new Promise(resolve => do_timeout(10, resolve));
}

add_setup(function () {
  const account = MailServices.accounts.createLocalMailAccount();
  const rootFolder = account.incomingServer.rootFolder;
  rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);

  inbox = rootFolder.createLocalSubfolder("reaperInbox");
  archive = rootFolder.createLocalSubfolder("reaperArchive");
  for (const folder of [inbox, archive]) {
    folder
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .addMessage(generator.makeMessage().toMessageString());
  }
});

/** Reading .msgDatabase is what opens a summary, and what should be undone. */
add_task(async function testIdleSummariesReleased() {
  Assert.ok(inbox.msgDatabase, "reading the summary should open it");
  Assert.ok(archive.msgDatabase, "reading the summary should open it");
  Assert.ok(inbox.databaseOpen, "the inbox summary should be open");
  Assert.ok(archive.databaseOpen, "the archive summary should be open");
  await tick();

  // Zero, so that summaries opened moments ago in this test count as idle.
  // Creating the account opens summaries of its own -- Trash and the like --
  // so the count is a floor rather than an exact number.
  const released = SummaryDatabaseReaper.sweep(0);

  Assert.greaterOrEqual(released, 2, "both summaries should be released");
  Assert.ok(!inbox.databaseOpen, "the inbox summary should be closed");
  Assert.ok(!archive.databaseOpen, "the archive summary should be closed");
});

/**
 * A summary read a moment ago is not idle, and taking it would mean a folder
 * being clicked through re-read its own summary on every sweep.
 */
add_task(async function testRecentlyUsedSummariesKept() {
  Assert.ok(inbox.msgDatabase, "reopen the summary");
  Assert.ok(inbox.databaseOpen, "the inbox summary should be open again");
  await tick();

  const released = SummaryDatabaseReaper.sweep();

  Assert.equal(released, 0, "a summary just read should not be released");
  Assert.ok(inbox.databaseOpen, "the inbox summary should still be open");

  // Leave nothing open for whatever runs next.
  SummaryDatabaseReaper.sweep(0);
});

/** Sweeping with nothing open is a no-op, not an error. */
add_task(async function testSweepWithNothingOpen() {
  await tick();
  Assert.equal(SummaryDatabaseReaper.sweep(0), 0, "nothing to release");
});
