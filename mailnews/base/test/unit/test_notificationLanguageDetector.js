/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests that asking the language detector a short question does not strand its
 * worker.
 *
 * The detector keeps an Emscripten heap of some sixteen megabytes in a worker,
 * and schedules that worker's termination only after it has processed a string
 * of 1.5MB or more -- the size at which the heap has grown and, since an
 * Emscripten heap does not shrink, is worth throwing away. That rule suits
 * detecting the language of a web page. New mail notifications ask about a
 * preview of a few dozen characters, which never reaches the threshold, so
 * without asking for the worker to go it stays for the life of the
 * application.
 */

const { LanguageDetector, workerManager } = ChromeUtils.importESModule(
  "resource://gre/modules/translations/LanguageDetector.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

// A notification-sized preview, nowhere near the 1.5MB the manager watches for.
const PREVIEW = "Here is the beginning of a message, as a notification shows it.";

add_setup(function () {
  // The real timeout is ten seconds, which is a long time to hold a test open.
  workerManager.IDLE_TIMEOUT = 50;
});

/** Detecting on its own leaves the worker running -- the reason for the fix. */
add_task(async function testShortDetectionStrandsTheWorker() {
  const { language } = await LanguageDetector.detectLanguage(PREVIEW);
  Assert.equal(language, "en", "the preview should be detected as English");
  Assert.ok(workerManager.worker, "detecting should have started a worker");

  // Nothing schedules its termination, so it is still there a moment later.
  await new Promise(resolve => do_timeout(200, resolve));
  Assert.ok(
    workerManager.worker,
    "a short detection alone should not schedule termination"
  );
});

/** Which is why MailNotificationManager asks for it to go. */
add_task(async function testFlushingSendsTheWorkerAway() {
  Assert.ok(workerManager.worker, "the worker from the last task is still up");

  workerManager.flushWorker();

  await TestUtils.waitForCondition(
    () => !workerManager.worker,
    "the worker should be terminated once idle"
  );
  Assert.ok(!workerManager.worker, "the worker should be gone");
});

/** And asking again still works, on a worker built afresh. */
add_task(async function testDetectionStillWorksAfterwards() {
  const { language } = await LanguageDetector.detectLanguage(PREVIEW);
  Assert.equal(language, "en", "detection should still work");
  Assert.ok(workerManager.worker, "a new worker should have been started");
  workerManager.flushWorker();
});
