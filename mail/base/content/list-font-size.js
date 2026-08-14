/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/* globals Services */

/**
 * Sizes the folder pane and the message list, through mail.listfontsize.
 *
 * These are where font size actually costs something: a larger size means
 * fewer messages and fewer folders visible at once. Sizing them separately
 * lets the rest of the interface stay where mail.uifontsize puts it.
 *
 * Applied to this document's root, which is about:3pane -- the folder pane
 * and the message list live here, and nothing else does. Marked important
 * because the responsive rules in about3Pane.css set the same property that
 * way and would otherwise win.
 *
 * Zero, the default, removes it and both panes follow the interface font.
 */
var ListFontSize = {
  PREF: "mail.listfontsize",

  init() {
    this.apply();
    Services.prefs.addObserver(this.PREF, this);
    window.addEventListener("unload", () => {
      Services.prefs.removeObserver(this.PREF, this);
    }, { once: true });
  },

  observe() {
    this.apply();
  },

  apply() {
    const size = Services.prefs.getIntPref(this.PREF, 0);
    const root = document.documentElement;
    if (size > 0) {
      root.style.setProperty("font-size", `${size}px`, "important");
    } else {
      root.style.removeProperty("font-size");
    }
  },
};

window.addEventListener("load", () => ListFontSize.init(), { once: true });
