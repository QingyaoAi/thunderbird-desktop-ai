/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests that an open summary database reports the memory it is using.
 *
 * MsgDBReporter holds its database weakly, so that a reporter cannot be the
 * reason a database stays in memory. That only works if nsMsgDatabase can be
 * weakly referenced at all: when it could not, do_GetWeakReference failed
 * silently in the reporter's constructor, do_QueryReferent then handed back
 * null on every collection, and every summary in the application reported
 * zero bytes against the path "explicit/maildb/database(UNKNOWN-FOLDER)".
 * The effect was that the largest consumer in a mail process was invisible to
 * about:memory, and turned up only as heap-unclassified.
 */

/* globals MailServices */

const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);

/**
 * Collect the memory reports under explicit/maildb.
 *
 * @param prefix
 * @returns {Promise<Array<{path: string, amount: integer}>>}
 */
function collectReports(prefix = "explicit/maildb/") {
  const manager = Cc["@mozilla.org/memory-reporter-manager;1"].getService(
    Ci.nsIMemoryReporterManager
  );
  const found = [];
  return new Promise(resolve => {
    manager.getReports(
      (process, path, kind, units, amount) => {
        if (path.startsWith(prefix)) {
          found.push({ path, amount });
        }
      },
      null,
      () => resolve(found),
      null,
      /* anonymize = */ false
    );
  });
}

add_task(async function testOpenDatabaseIsReported() {
  const account = MailServices.accounts.createLocalMailAccount();
  const rootFolder = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  const folder = rootFolder
    .createLocalSubfolder("reported")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);

  const generator = new MessageGenerator();
  for (let i = 0; i < 50; i++) {
    folder.addMessage(generator.makeMessage().toMessageString());
  }

  // Reading the summary opens it, and reading every header is what puts them
  // in the table the reporter walks.
  const database = folder.msgDatabase;
  Assert.ok(database, "the summary should be open");
  Assert.equal(
    [...database.enumerateMessages()].length,
    50,
    "every message should be readable"
  );

  const reports = await collectReports();
  Assert.greater(reports.length, 0, "a summary should be reported at all");

  const mine = reports.filter(r => r.path.includes("reported"));
  Assert.deepEqual(
    mine.map(r => r.path.replace(/^.*\)\//, "")).sort(),
    ["headers", "other"],
    "the summary's own allocations should be reported in their two parts"
  );

  const part = name => mine.find(r => r.path.endsWith("/" + name)).amount;
  Assert.greater(
    part("headers") + part("other"),
    0,
    "the summary should not measure zero bytes in total"
  );

  // Mork's figure comes from its own allocator's running total, which is
  // right at open and only rises afterwards. It is reported, but not under
  // explicit/, where it would be claiming part of a heap it can outgrow.
  const mork = (await collectReports("maildb-mork/")).filter(r =>
    r.path.includes("reported")
  );
  Assert.equal(mork.length, 1, "the mork store is reported for this folder");
  Assert.greater(mork[0].amount, 0, "and an open one is not zero");

  Assert.ok(
    !reports.some(r => r.path.includes("UNKNOWN-FOLDER")),
    "no reporter should have lost track of its database"
  );
});

/**
 * The bug that made this worth asserting: mork's count was reported under
 * explicit/, where it grew past the whole process heap and drove
 * heap-unclassified negative -- which makes every other figure in the
 * process unreadable, not just this one.
 */
add_task(async function testExplicitStaysWithinTheHeap() {
  const manager = Cc["@mozilla.org/memory-reporter-manager;1"].getService(
    Ci.nsIMemoryReporterManager
  );
  const explicit = (await collectReports("explicit/maildb/")).reduce(
    (sum, r) => sum + r.amount,
    0
  );

  Assert.lessOrEqual(
    explicit,
    manager.heapAllocated,
    "what maildb claims under explicit/ has to fit in the heap it claims from"
  );
});
