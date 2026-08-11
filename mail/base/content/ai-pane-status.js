/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/* globals Services */

/**
 * The status bar button that shows and hides the AI pane, alongside the one
 * for the Today Pane.
 *
 * The pane itself lives inside about:3pane, one per mail tab, so the button
 * reads its state from whichever tab is in front rather than keeping a copy
 * of its own -- and hides itself on tabs that have no such pane, where there
 * would be nothing for it to act on.
 */
var AIPaneStatus = {
  /** @type {?Element} */
  button: null,

  init() {
    this.button = document.getElementById("ai-pane-status-button");
    if (!this.button) {
      return;
    }

    // The pane can also be closed from its own header, and switching tabs
    // can bring a differently-configured one to the front.
    Services.obs.addObserver(this, "ai-pane-visibility-changed");
    const tabmail = document.getElementById("tabmail");
    tabmail?.addEventListener("TabSelect", this);
    tabmail?.addEventListener("TabOpen", this);
    window.addEventListener("unload", this, { once: true });

    this.update();
  },

  handleEvent(event) {
    if (event.type == "unload") {
      Services.obs.removeObserver(this, "ai-pane-visibility-changed");
      return;
    }
    // A newly selected tab may still be building its document.
    Services.tm.dispatchToMainThread(() => this.update());
  },

  observe() {
    this.update();
  },

  /**
   * The about:3pane of the frontmost tab, if it has one.
   *
   * @returns {?Window}
   */
  get pane() {
    return document.getElementById("tabmail")?.currentAbout3Pane ?? null;
  },

  /** Match the button to the pane in the current tab. */
  update() {
    if (!this.button) {
      return;
    }
    const box = this.pane?.document?.getElementById("aiPane");
    this.button.hidden = !box;
    this.button.checked = Boolean(box && !box.hidden);
  },

  toggle() {
    const pane = this.pane;
    if (!pane) {
      return;
    }
    pane.AIPanelUI.toggle().then(
      () => this.update(),
      ex => console.error("Could not toggle the AI pane:", ex)
    );
  },
};

window.addEventListener("load", () => AIPaneStatus.init(), { once: true });
