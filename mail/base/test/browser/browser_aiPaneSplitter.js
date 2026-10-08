/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The splitter between the message pane and the AI pane takes hold on both
 * sides of the line between them, not only on the message pane's.
 */

const about3Pane = document.getElementById("tabmail").currentAbout3Pane;
const doc = about3Pane.document;

let splitter, pane, middle;

/** @returns {number} Where the AI pane begins. */
function edge() {
  return pane.getBoundingClientRect().left;
}

/**
 * Press the mouse at a point across the window, move it and let go.
 *
 * @param {number} x
 * @param {number} by - How far to move, to the right.
 */
async function drag(x, by) {
  const frame = () => new Promise(r => about3Pane.requestAnimationFrame(r));
  EventUtils.synthesizeMouseAtPoint(
    x,
    middle,
    { type: "mousedown", buttons: 1 },
    about3Pane
  );
  // The splitter takes one move a frame.
  for (let step = 1; step <= 4; step++) {
    await frame();
    EventUtils.synthesizeMouseAtPoint(
      x + (by * step) / 4,
      middle,
      { type: "mousemove", buttons: 1 },
      about3Pane
    );
  }
  await frame();
  EventUtils.synthesizeMouseAtPoint(
    x + by,
    middle,
    { type: "mouseup", buttons: 0 },
    about3Pane
  );
  await frame();
}

add_setup(async function () {
  // A folder to show, so that the panes are there at all.
  const account = MailServices.accounts.createLocalMailAccount();
  const folder = account.incomingServer.rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("aiPaneSplitter");
  about3Pane.restoreState({
    folderURI: folder.URI,
    messagePaneVisible: true,
  });
  await about3Pane.AIPanelUI.toggle(true);

  splitter = doc.getElementById("aiPaneSplitter");
  pane = doc.getElementById("aiPane");
  const box = splitter.getBoundingClientRect();
  middle = (box.top + box.bottom) / 2;

  registerCleanupFunction(() => {
    splitter.width = null;
    MailServices.accounts.removeAccount(account, false);
  });
});

add_task(function testWhereItTakesHold() {
  const at = offset => doc.elementFromPoint(edge() + offset, middle);
  Assert.equal(at(-4.5), splitter, "over the edge of the message pane");
  Assert.equal(at(-0.5), splitter, "on the line it draws");
  Assert.equal(at(0.5), splitter, "on the AI pane's border beside that");
  Assert.equal(at(4.5), splitter, "and in the padding inside the AI pane");
  Assert.notEqual(at(-5.5), splitter, "but no further into the message pane");
  Assert.notEqual(at(5.5), splitter, "or into the AI pane");
  Assert.equal(
    about3Pane.getComputedStyle(splitter, "::before").cursor,
    "ew-resize",
    "the pointer says so on the AI pane's side too"
  );
});

add_task(async function testDraggingFromEitherSide() {
  const width = () => pane.getBoundingClientRect().width;
  const before = width();

  await drag(edge() + 2.5, -50);
  Assert.equal(width(), before + 50, "taken hold of inside the AI pane");

  await drag(edge() - 2.5, 50);
  Assert.equal(width(), before, "and from the message pane's side, back again");

  await drag(edge() + 8.5, -50);
  Assert.equal(width(), before, "further in is the pane, not its edge");
});
