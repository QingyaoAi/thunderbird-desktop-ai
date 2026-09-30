/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests that an attachment the pointer rests on is written to a file before
 * a drag from it begins, so that the first drag hands over the file itself
 * rather than a link to the message part.
 */

"use strict";

var { be_in_folder, create_folder, get_about_message, select_click_row } =
  ChromeUtils.importESModule(
    "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
  );
var { add_message_to_folder, create_message } = ChromeUtils.importESModule(
  "resource://testing-common/mail/MessageInjectionHelpers.sys.mjs"
);

const attachmentText =
  "Friends, this is clean-up time and we're discounting all our " +
  "silent, electric Ubiks by this much money.";

let folder;

add_setup(async function () {
  folder = await create_folder("AttachmentDragStaging");
  await add_message_to_folder(
    [folder],
    create_message({
      subject: "several attachments",
      attachments: ["first.txt", "second.txt", "third.txt"].map(filename => ({
        body: attachmentText,
        filename,
        format: "",
      })),
    })
  );
  await add_message_to_folder(
    [folder],
    create_message({
      subject: "one attachment",
      attachments: [{ body: attachmentText, filename: "only.txt", format: "" }],
    })
  );
  await be_in_folder(folder);

  registerCleanupFunction(() => {
    folder.deleteSelf(null);
  });
});

/**
 * Start a drag from `target` and report what it would hand over.
 *
 * @param {Element} target
 * @returns {{types: string[], file: ?nsIFile}}
 */
function dragFrom(target) {
  const dataTransfer = new DataTransfer();
  target.dispatchEvent(
    new DragEvent("dragstart", {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    })
  );
  const types = Array.from(dataTransfer.mozTypesAt(0));
  const file = types.includes("application/x-moz-file")
    ? dataTransfer
        .mozGetDataAt("application/x-moz-file", 0)
        .QueryInterface(Ci.nsIFile)
    : null;
  return { types, file };
}

/**
 * Rest the pointer on `target`, and wait until a drag from it would hand over
 * the attachment as a file.
 *
 * @param {Window} win - The about:message window.
 * @param {Element} target
 * @param {string} name - The attachment's file name.
 */
async function subtest_hover_stages(win, target, name) {
  EventUtils.synthesizeMouseAtCenter(target, { type: "mousemove" }, win);

  let drag;
  await TestUtils.waitForCondition(() => {
    drag = dragFrom(target);
    return drag.file;
  }, `resting on ${name} should write it to a file`);

  Assert.equal(drag.file.leafName, name, "the file should be named for it");
  Assert.equal(
    await IOUtils.readUTF8(drag.file.path),
    attachmentText,
    "the file should hold the attachment"
  );
  Assert.ok(
    !drag.types.includes("text/x-moz-url"),
    "a drag of the file should not also offer a link to the message part"
  );
}

add_task(async function test_attachment_list() {
  await select_click_row(0);
  const win = get_about_message();
  win.toggleAttachmentList(true);

  const items = win.document.querySelectorAll(
    "#attachmentList .attachmentItem"
  );
  Assert.equal(items.length, 3, "all three attachments should be listed");
  const elsewhere = win.document.getElementById("attachmentCount");

  // Nothing has been near the first attachment, so its drag falls back to the
  // promise and the link, as every first drag used to.
  EventUtils.synthesizeMouseAtCenter(elsewhere, { type: "mousemove" }, win);
  const cold = dragFrom(items[0]);
  Assert.ok(!cold.file, "an attachment not yet written is not offered as one");
  Assert.ok(
    cold.types.includes("text/x-moz-url"),
    "an attachment not yet written is offered as a link"
  );

  // Passing over the second on the way somewhere else writes nothing.
  EventUtils.synthesizeMouseAtCenter(items[1], { type: "mousemove" }, win);
  EventUtils.synthesizeMouseAtCenter(elsewhere, { type: "mousemove" }, win);
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 500));
  Assert.ok(
    !dragFrom(items[1]).file,
    "an attachment the pointer only passed over should not be written"
  );

  await subtest_hover_stages(win, items[2], "third.txt");
});

add_task(async function test_single_attachment_name() {
  await select_click_row(1);
  const win = get_about_message();
  const attachmentName = win.document.getElementById("attachmentName");
  Assert.ok(
    BrowserTestUtils.isVisible(attachmentName),
    "a lone attachment should be named in the attachment bar"
  );

  await subtest_hover_stages(win, attachmentName, "only.txt");
});
