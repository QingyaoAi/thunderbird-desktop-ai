/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/* globals Services */

/**
 * Sizes the menus on their own, through mail.menufontsize.
 *
 * Separate from UIFontSize, which sizes the whole interface: someone who
 * wants the mail list large does not necessarily want the menu bar and its
 * popups to take the same space, and the reverse is just as common.
 *
 * Applied here rather than inside UIFontSize because that module only
 * touches windows it has registered, and does so on its own schedule; this
 * needs to run for this window whenever the pref changes and at startup.
 * A custom property rather than a font-size on the root, so it reaches the
 * menus alone. Zero -- the default -- removes the property, and the menus
 * inherit the interface font exactly as they did before.
 */
var MenuFontSize = {
  PREF: "mail.menufontsize",

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
      root.style.setProperty("--menu-font-size", `${size}px`);
    } else {
      root.style.removeProperty("--menu-font-size");
    }
  },
};

window.addEventListener("load", () => MenuFontSize.init(), { once: true });
