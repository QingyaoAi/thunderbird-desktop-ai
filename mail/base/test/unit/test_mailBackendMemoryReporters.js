/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests that the two parts of the mail backend whose size follows the size of
 * a mailbox -- the open views and the open IMAP connections -- report what
 * they are holding.
 *
 * Neither did, and between them they were a large share of the memory a mail
 * process could not account for: about:memory attributed a third of the heap
 * to nothing at all. What they turn out to hold is modest, but "modest" was
 * not something that could be established from a number before this.
 */

/* import-globals-from resources/viewWrapperTestUtils.js */
load("resources/viewWrapperTestUtils.js");
initViewWrapperTestUtils({ mode: "imap", offline: false });

/**
 * @param {string} path - The report path to total.
 * @returns {Promise<integer>} Bytes reported against it.
 */
function reported(path) {
  const manager = Cc["@mozilla.org/memory-reporter-manager;1"].getService(
    Ci.nsIMemoryReporterManager
  );
  let total = 0;
  let seen = false;
  return new Promise(resolve => {
    manager.getReports(
      (process, reportPath, kind, units, amount) => {
        // Prefixes, so a report that is later broken into parts still totals.
        if (reportPath == path || reportPath.startsWith(path + "/")) {
          seen = true;
          total += amount;
        }
      },
      null,
      () => resolve(seen ? total : null),
      null,
      false
    );
  });
}

add_task(async function testOpenViewIsReported() {
  Assert.equal(
    await reported("explicit/mail-views"),
    null,
    "nothing should be reported before a view exists"
  );

  const [[msgFolder]] = await messageInjection.makeFoldersWithSets(1, [
    { count: 300 },
  ]);
  const viewWrapper = make_view_wrapper();
  await view_open(viewWrapper, messageInjection.getRealInjectionFolder(msgFolder));

  const withView = await reported("explicit/mail-views");
  Assert.greater(withView, 0, "an open view should report the rows it holds");

  // Three arrays of four bytes a row, plus the view itself. Anything wildly
  // above that would mean the view is holding something this does not know
  // about, which is the thing worth being told.
  Assert.less(
    withView,
    300 * 12 + 65536,
    "a three hundred row view should cost about twelve bytes a row"
  );

  viewWrapper.close();
});

add_task(async function testImapConnectionIsReported() {
  // The injection above has spoken to the fake server, so a connection exists.
  const connections = await reported("explicit/imap-connections");
  Assert.notEqual(
    connections,
    null,
    "an IMAP connection should report what it holds"
  );
  Assert.greater(connections, 0, "the report should not be empty");

  // The parts are what makes the figure actionable: a mailbox's size and the
  // server's keywords for it grow for different reasons.
  const messageState = await reported(
    "explicit/imap-connections/message-state"
  );
  Assert.greater(
    messageState,
    0,
    "a selected mailbox should report its per-message state"
  );
  Assert.notEqual(
    await reported("explicit/imap-connections/keywords"),
    null,
    "keywords should be reported even when the server sends none"
  );
});
