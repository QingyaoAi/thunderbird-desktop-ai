/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests that starting up offline is recoverable.
 *
 * The startup handler used to return before reading offline.startup_state
 * whenever it found itself offline with manageOfflineStatus off. Those two
 * together are a state nothing else leaves: manageOfflineStatus off is
 * exactly the setting that stops the application following the network, so
 * every later launch took the same early exit. It shows up as an application
 * that has quietly stopped fetching mail -- no error, no connection
 * attempted, and Get Messages doing nothing at all.
 */

const { OfflineStartup } = ChromeUtils.importESModule(
  "resource:///modules/OfflineStartup.sys.mjs"
);

const ALWAYS_ONLINE = 2;
const ALWAYS_OFFLINE = 3;

/**
 * Put the world into a given state and run one profile startup over it.
 *
 * @param {object} state
 * @param {boolean} state.offline - What the IO service starts as.
 * @param {boolean} state.manageStatus - Whether it follows the network.
 * @param {integer} state.startupState - The offline.startup_state setting.
 * @returns {boolean} Whether it is offline afterwards.
 */
function startUpWith({ offline, manageStatus, startupState }) {
  Services.io.manageOfflineStatus = manageStatus;
  Services.io.offline = offline;
  Services.prefs.setIntPref("offline.startup_state", startupState);
  // Off, so the startup mode decides rather than the network.
  Services.prefs.setBoolPref("offline.autoDetect", false);

  // A fresh handler each time: one only acts on its first call.
  new OfflineStartup().onProfileStartup();
  return Services.io.offline;
}

add_task(function testAlwaysOnlineWinsOverStartingUpOffline() {
  Assert.equal(
    startUpWith({
      offline: true,
      manageStatus: false,
      startupState: ALWAYS_ONLINE,
    }),
    false,
    "asked to be always online, starting up offline should be corrected"
  );
});

add_task(function testAlwaysOfflineIsStillRespected() {
  Assert.equal(
    startUpWith({
      offline: true,
      manageStatus: false,
      startupState: ALWAYS_OFFLINE,
    }),
    true,
    "asked to be always offline, it stays offline"
  );
});

add_task(function testStartingUpOnlineIsLeftAlone() {
  Assert.equal(
    startUpWith({
      offline: false,
      manageStatus: false,
      startupState: ALWAYS_ONLINE,
    }),
    false,
    "starting up online stays online"
  );
});
