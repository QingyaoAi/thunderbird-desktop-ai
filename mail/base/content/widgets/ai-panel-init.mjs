/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Wires the AI panel into the mail window.
 *
 * Kept to the smallest possible amount of work at startup: it puts the two
 * objects where menu commands can reach them and restores whether the pane
 * was open. Nothing else about the panel -- and nothing AI-related at all --
 * is loaded until the pane is actually shown.
 */

import { AIPanel, AIPanelUI } from "chrome://messenger/content/ai-panel.mjs";

window.AIPanel = AIPanel;
window.AIPanelUI = AIPanelUI;

window.addEventListener(
  "load",
  () => {
    AIPanelUI.restore().catch(console.error);
  },
  { once: true }
);
