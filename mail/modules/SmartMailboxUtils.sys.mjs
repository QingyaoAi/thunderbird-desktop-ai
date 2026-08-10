/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  MailServices: "resource:///modules/MailServices.sys.mjs",
  VirtualFolderHelper: "resource:///modules/VirtualFolderWrapper.sys.mjs",
});

const messengerBundle = Services.strings.createBundle(
  "chrome://messenger/locale/messenger.properties"
);

const folderTypes = [
  { flag: Ci.nsMsgFolderFlags.Inbox, name: "Inbox", type: "inbox" },
  { flag: Ci.nsMsgFolderFlags.Drafts, name: "Drafts", type: "drafts" },
  { flag: Ci.nsMsgFolderFlags.Templates, name: "Templates", type: "templates" },
  { flag: Ci.nsMsgFolderFlags.SentMail, name: "Sent", type: "sent" },
  { flag: Ci.nsMsgFolderFlags.Archive, name: "Archives", type: "archives" },
  { flag: Ci.nsMsgFolderFlags.Junk, name: "Junk", type: "junk" },
  { flag: Ci.nsMsgFolderFlags.Trash, name: "Trash", type: "trash" },
  // { flag: Ci.nsMsgFolderFlags.Queue, name: "Outbox", type: "outbox" },
];
const allSpecialFolderFlags =
  Ci.nsMsgFolderFlags.SpecialUse | Ci.nsMsgFolderFlags.Virtual;

/**
 * The preference holding the VIP address list, as a comma separated string of
 * email addresses. Kept as a plain pref (rather than a property on address
 * book cards) so that VIP status does not depend on the sender already being
 * a saved contact.
 */
const VIP_PREF = "mail.vip.addresses";

/**
 * Physical folder name of the aggregate "All VIPs" folder. Not derived from
 * an address, so it can never collide with a per-VIP folder key.
 */
const ALL_VIP_FOLDER_KEY = "vip_all";

/**
 * Read/write helpers for the VIP list.
 *
 * The pref holds comma separated entries, each either a bare address or
 * "address|Display Name", e.g.:
 *
 *   alice@example.com|Alice Smith,bob@example.org
 *
 * Keeping it a readable string (rather than JSON) means the list can still
 * be edited by hand in the Config Editor. Addresses are compared lower
 * cased; display names are kept verbatim.
 */
export const VipAddresses = {
  /**
   * @returns {Array<{address: string, name: string}>} The VIP entries, in
   *   pref order, without duplicates or empty entries. `name` falls back to
   *   the address when no display name was recorded.
   */
  getEntries() {
    const raw = Services.prefs.getStringPref(VIP_PREF, "");
    const entries = [];
    const seen = new Set();
    for (const part of raw.split(",")) {
      const [rawAddress, ...nameParts] = part.split("|");
      const address = rawAddress?.trim().toLowerCase();
      if (!address || seen.has(address)) {
        continue;
      }
      seen.add(address);
      entries.push({
        address,
        name: nameParts.join("|").trim() || address,
      });
    }
    return entries;
  },

  /**
   * @returns {string[]} Just the addresses, for callers that don't care
   *   about display names.
   */
  get() {
    return this.getEntries().map(e => e.address);
  },

  /**
   * @param {string} address
   * @returns {boolean} Whether the address is currently a VIP.
   */
  has(address) {
    return this.get().includes(address?.trim().toLowerCase());
  },

  /**
   * Write the list back out, preserving display names.
   *
   * @param {Array<{address: string, name: string}>} entries
   */
  setEntries(entries) {
    Services.prefs.setStringPref(
      VIP_PREF,
      entries
        .map(e =>
          e.name && e.name != e.address ? `${e.address}|${e.name}` : e.address
        )
        .join(",")
    );
  },

  /**
   * Add an address to the VIP list. No-op if it is already there.
   *
   * @param {string} address
   * @param {string} [name] - Display name to use for this VIP's folder.
   */
  add(address, name) {
    const normalized = address?.trim().toLowerCase();
    if (!normalized || this.has(normalized)) {
      return;
    }
    this.setEntries([
      ...this.getEntries(),
      { address: normalized, name: name?.trim() || normalized },
    ]);
  },

  /**
   * Change the display name recorded for a VIP, which is what their folder
   * is named. No-op if the address isn't a VIP.
   *
   * @param {string} address
   * @param {string} name
   */
  setName(address, name) {
    const normalized = address?.trim().toLowerCase();
    const entries = this.getEntries();
    const entry = entries.find(e => e.address == normalized);
    if (!entry) {
      return;
    }
    entry.name = name?.trim() || normalized;
    this.setEntries(entries);
  },

  /**
   * Remove an address from the VIP list. No-op if it is not there.
   *
   * @param {string} address
   */
  remove(address) {
    const normalized = address?.trim().toLowerCase();
    this.setEntries(this.getEntries().filter(e => e.address != normalized));
  },

  /**
   * Reverse of vipFolderKey(): which VIP a folder belongs to. The key is
   * lossy (punctuation is collapsed), so this matches by recomputing each
   * known VIP's key rather than trying to decode it.
   *
   * @param {string} key - Physical folder name, e.g. "vip_alice_example_com".
   * @returns {?string} The VIP's address, or null if it isn't a VIP folder.
   */
  addressForFolderKey(key) {
    return (
      this.getEntries().find(e => vipFolderKey(e.address) == key)?.address ??
      null
    );
  },
};

/**
 * Turn an email address into something usable as an on-disk folder name.
 * The address itself is kept as the folder's display name; this is only the
 * physical name, mirroring how tag folders are stored under their tag key.
 *
 * @param {string} address
 * @returns {string}
 */
function vipFolderKey(address) {
  return "vip_" + address.replace(/[^a-z0-9]+/gi, "_");
}

class SmartMailbox {
  #tagsFolder = null;
  #vipFolder = null;
  #rootFolder = null;
  #server = null;
  #account = null;
  #TagFolderURIs = new Map();
  #VipFolderURIs = new Map();

  constructor() {
    this.verify();
  }

  /**
   * Returns the server of the smart mailbox account.
   *
   * @returns {nsIMsgIncomingServer}
   */
  get server() {
    return this.#server;
  }

  /**
   * Returns the smart mailbox account.
   *
   * @returns {nsIMsgAccount}
   */
  get account() {
    return this.#account;
  }

  /**
   * Returns the root folder of the smart mailbox account.
   *
   * @returns {nsIMsgFolder}
   */
  get rootFolder() {
    return this.#rootFolder;
  }

  /**
   * Returns the tags folder of the smart mailbox account.
   *
   * @returns {nsIMsgFolder}
   */
  get tagsFolder() {
    return this.#tagsFolder;
  }

  /**
   * Returns the VIP folder of the smart mailbox account, which holds the
   * per-VIP virtual folders.
   *
   * @returns {nsIMsgFolder}
   */
  get vipFolder() {
    return this.#vipFolder;
  }

  /**
   * Creates or updates the smart mailbox server.
   */
  verify() {
    let smartServer = lazy.MailServices.accounts.findServer(
      "nobody",
      "smart mailboxes",
      "none"
    );
    if (!smartServer) {
      smartServer = lazy.MailServices.accounts.createIncomingServer(
        "nobody",
        "smart mailboxes",
        "none"
      );
      // We don't want the "smart" server/account leaking out into the ui in
      // other places, so set it as hidden.
      smartServer.hidden = true;
      const account = lazy.MailServices.accounts.createAccount();
      account.incomingServer = smartServer;
    }
    smartServer.prettyName =
      messengerBundle.GetStringFromName("unifiedAccountName");
    this.#rootFolder = smartServer.rootFolder.QueryInterface(
      Ci.nsIMsgLocalMailFolder
    );

    // Create smart folders, if missing.
    for (const folderType of folderTypes) {
      this.getSmartFolder(folderType.name);
    }

    // Create root tag folder, if missing.
    this.#tagsFolder =
      this.#rootFolder.getChildWithURI(
        `${this.#rootFolder.URI}/tags`,
        false,
        false
      ) ?? this.#rootFolder.createLocalSubfolder("tags");
    this.#tagsFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);

    // Remove obsolete tag folders.
    const tags = lazy.MailServices.tags.getAllTags();
    const obsoleteFolders = this.#tagsFolder.subFolders.filter(
      folder => !tags.some(t => t.tag == folder.name)
    );
    for (const folder of obsoleteFolders) {
      folder.deleteSelf(null);
    }

    // Create tag folders, if missing.
    for (const tag of tags) {
      this.getTagFolder(tag);
    }

    // Create root VIP folder, if missing.
    this.#vipFolder =
      this.#rootFolder.getChildWithURI(
        `${this.#rootFolder.URI}/vip`,
        false,
        false
      ) ?? this.#rootFolder.createLocalSubfolder("vip");
    this.#vipFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);

    // Remove VIP folders for addresses that are no longer VIPs. The
    // aggregate folder is keyed separately and is always kept.
    const vipEntries = VipAddresses.getEntries();
    const wantedVipNames = new Set([
      ALL_VIP_FOLDER_KEY,
      ...vipEntries.map(e => vipFolderKey(e.address)),
    ]);
    for (const folder of this.#vipFolder.subFolders) {
      // Match on the physical name, which is the stable key. The display
      // name deliberately isn't used here: it's user-facing and can be
      // renamed, and matching on it would delete renamed folders.
      const key = folder.URI.split("/").pop();
      if (!wantedVipNames.has(key)) {
        folder.deleteSelf(null);
      }
    }

    // Create VIP folders, if missing.
    this.getAllVipFolder();
    for (const entry of vipEntries) {
      this.getVipFolder(entry.address, entry.name);
    }

    lazy.MailServices.accounts.saveVirtualFolders();
    this.#server = smartServer;
    this.#account = lazy.MailServices.accounts.findAccountForServer(
      this.#server
    );
  }

  /**
   * Returns the smart folder with the specified name. Attempts to create it, if
   * it does not exist yet.
   *
   * @param {string} name
   * @returns {?nsIMsgFolder}
   */
  getSmartFolder(name) {
    // Note: Smart folder URIs use the names as listed in the folderTypes array
    // (e.g.: mailbox://nobody@smart%20mailboxes/Inbox), but their actual names
    // will be localized. A folder lookup here via getChildNamed() will therefore
    // fail on localized systems (unless the localized name is used for the lookup).
    const folderType = folderTypes.find(f => f.name == name);
    const folderFromUri = this.#rootFolder.getChildWithURI(
      `${this.#rootFolder.URI}/${folderType.name}`,
      false,
      true
    );
    if (folderFromUri) {
      return folderFromUri;
    }

    try {
      const searchFolders = [];

      const recurse = function (mainFolder) {
        let subFolders;
        try {
          subFolders = mainFolder.subFolders;
        } catch (ex) {
          console.error(
            new Error(`Unable to access the subfolders of ${mainFolder.URI}`, {
              cause: ex,
            })
          );
        }
        if (!subFolders?.length) {
          return;
        }

        for (const sf of subFolders) {
          // Add all real subfolders except the ones that belong to
          // a different folder type.
          if (!(sf.flags & allSpecialFolderFlags)) {
            searchFolders.push(sf);
            recurse(sf);
          }
        }
      };

      for (const server of lazy.MailServices.accounts.allServers) {
        for (const f of server.rootFolder.getFoldersWithFlags(
          folderType.flag
        )) {
          searchFolders.push(f);
          recurse(f);
        }
      }

      const wrapper = lazy.VirtualFolderHelper.createNewVirtualFolder(
        folderType.name,
        this.#rootFolder,
        searchFolders,
        "ALL",
        true
      );
      const folder = wrapper.virtualFolder;
      folder.setFlag(folderType.flag);

      const msgDatabase = folder.msgDatabase;
      const folderInfo = msgDatabase.dBFolderInfo;
      folderInfo.setUint32Property("searchFolderFlag", folderType.flag);
      msgDatabase.summaryValid = true;
      msgDatabase.close(true);

      this.#rootFolder.notifyFolderAdded(folder);
    } catch (ex) {
      console.error(`Failed to create smart folder <${folderType.name}>`, ex);
    }

    return null;
  }

  /**
   * Returns the virtual folder searching messages for `tag`, creates it if
   * does not exist yet.
   *
   * @param {nsIMsgTag} tag
   * @returns {nsIMsgFolder}
   */
  getTagFolder(tag) {
    // Use getChildWithURI() to get the folder via its known URI.
    const uri = this.#TagFolderURIs.get(tag.key);
    if (uri) {
      const folderFromUri = this.#tagsFolder.getChildWithURI(uri, false, true);
      if (folderFromUri) {
        return folderFromUri;
      }
    }

    // Use folder.getChildNamed() to identify the tag folder by its name.
    const folderFromName = this.#tagsFolder.getChildNamed(tag.tag);
    if (folderFromName) {
      this.#TagFolderURIs.set(tag.key, folderFromName.URI);
      return folderFromName;
    }

    try {
      const folder = this.#tagsFolder.createLocalSubfolder(tag.key);
      folder.flags |= Ci.nsMsgFolderFlags.Virtual;
      folder.name = tag.tag;
      this.#TagFolderURIs.set(tag.key, folder.URI);

      const msgDatabase = folder.msgDatabase;
      const folderInfo = msgDatabase.dBFolderInfo;

      folderInfo.setCharProperty("searchStr", `AND (tag,contains,${tag.key})`);
      folderInfo.setCharProperty("searchFolderUri", "*");
      folderInfo.setUint32Property(
        "searchFolderFlag",
        Ci.nsMsgFolderFlags.Inbox
      );
      folderInfo.setBooleanProperty("searchOnline", false);
      msgDatabase.summaryValid = true;
      msgDatabase.close(true);

      this.#tagsFolder.notifyFolderAdded(folder);
      return folder;
    } catch (ex) {
      console.error(`Failed to create tag folder <${tag.tag}>`, ex);
    }

    return null;
  }

  /**
   * Returns the currently known URI of the tag folder associated with a given
   * key. The folder does not necessarily have to exist.
   *
   * @param {string} key
   * @returns {string}
   */
  getTagFolderUriForKey(key) {
    return this.#TagFolderURIs.get(key);
  }

  /**
   * Create (or look up) a virtual folder gathering mail from one VIP address.
   *
   * @param {string} address - The VIP's email address.
   * @returns {?nsIMsgFolder}
   */
  getVipFolder(address, name) {
    return this.#createVipFolder(
      vipFolderKey(address),
      name || address,
      `AND (from,contains,${address})`
    );
  }

  /**
   * Create (or look up) the virtual folder gathering mail from every VIP.
   * Empty when there are no VIPs yet, which is why the search matches on a
   * sender address that cannot occur rather than matching everything.
   *
   * @returns {?nsIMsgFolder}
   */
  getAllVipFolder() {
    const addresses = VipAddresses.get();
    const searchStr = addresses.length
      ? addresses.map(a => `OR (from,contains,${a})`).join(" ")
      : "AND (from,contains, no-vips )";
    return this.#createVipFolder(
      ALL_VIP_FOLDER_KEY,
      messengerBundle.GetStringFromName("vipFolderName"),
      searchStr,
      // Keep the search string current as the VIP list changes.
      true
    );
  }

  /**
   * Shared construction for the VIP virtual folders.
   *
   * @param {string} key - Physical (on-disk) folder name.
   * @param {string} displayName - Name shown in the folder pane.
   * @param {string} searchStr - Virtual folder search condition.
   * @param {boolean} [refreshSearch] - Rewrite the search condition even if
   *   the folder already exists (used by the aggregate folder, whose search
   *   depends on the whole VIP list).
   * @returns {?nsIMsgFolder}
   */
  #createVipFolder(key, displayName, searchStr, refreshSearch = false) {
    // Look the folder up every way we can before trying to create it: by
    // remembered URI, by its constructed URI, and finally by name. Missing
    // the last of these means createLocalSubfolder() below throws for a
    // folder that already exists on disk, which loses the folder entirely.
    // (getTagFolder has the same three-step lookup for the same reason.)
    const uri = this.#VipFolderURIs.get(key);
    let folder =
      (uri && this.#vipFolder.getChildWithURI(uri, false, true)) ||
      this.#vipFolder.getChildWithURI(
        `${this.#vipFolder.URI}/${key}`,
        false,
        true
      ) ||
      this.#vipFolder.getChildNamed(key) ||
      this.#vipFolder.getChildNamed(displayName);

    if (folder) {
      this.#VipFolderURIs.set(key, folder.URI);

      // The VIP list is the source of truth for the folder's name, so that
      // editing the name there renames the folder. (nsIMsgFolder.rename()
      // has no effect on these virtual folders, so this is how a VIP gets
      // renamed.)
      const renaming = displayName && folder.name != displayName;
      if (renaming) {
        folder.name = displayName;
      }

      // SetName and the search string both live in the folder database, so
      // they only survive a restart if it is committed. Skipping this is
      // why a changed name appeared to be ignored.
      if (renaming || refreshSearch) {
        const msgDatabase = folder.msgDatabase;
        if (refreshSearch) {
          msgDatabase.dBFolderInfo.setCharProperty("searchStr", searchStr);
        }
        msgDatabase.summaryValid = true;
        msgDatabase.close(true);
      }
      return folder;
    }

    try {
      folder = this.#vipFolder.createLocalSubfolder(key);
      folder.flags |= Ci.nsMsgFolderFlags.Virtual;
      folder.name = displayName;
      this.#VipFolderURIs.set(key, folder.URI);

      const msgDatabase = folder.msgDatabase;
      const folderInfo = msgDatabase.dBFolderInfo;
      folderInfo.setCharProperty("searchStr", searchStr);
      folderInfo.setCharProperty("searchFolderUri", "*");
      folderInfo.setUint32Property(
        "searchFolderFlag",
        Ci.nsMsgFolderFlags.Inbox
      );
      folderInfo.setBooleanProperty("searchOnline", false);
      msgDatabase.summaryValid = true;
      msgDatabase.close(true);

      this.#vipFolder.notifyFolderAdded(folder);
      return folder;
    } catch (ex) {
      console.error(`Failed to create VIP folder <${displayName}>`, ex);
    }

    return null;
  }
}

let smartMailboxInstance = null;

export const SmartMailboxUtils = {
  /**
   * @returns {SmartMailbox}
   */
  getSmartMailbox() {
    if (!smartMailboxInstance) {
      smartMailboxInstance = new SmartMailbox();
    } else {
      smartMailboxInstance.verify();
    }
    return smartMailboxInstance;
  },

  /**
   * Remove the smart mailbox account (including the server), if it exists.
   *
   * @param {boolean} [removeFiles=false] - Remove data directory (local directory).
   */
  removeAll(removeFiles = false) {
    const smartServer = lazy.MailServices.accounts.findServer(
      "nobody",
      "smart mailboxes",
      "none"
    );
    if (!smartServer) {
      return;
    }
    const account =
      lazy.MailServices.accounts.findAccountForServer(smartServer);
    if (account) {
      lazy.MailServices.accounts.removeAccount(account, removeFiles);
    } else {
      lazy.MailServices.accounts.removeIncomingServer(smartServer, removeFiles);
    }
  },

  /**
   * Returns a clone of the folder type array defined at the top of this module.
   *
   * @returns {object[]}
   */
  getFolderTypes() {
    return folderTypes.map(folderType => ({ ...folderType }));
  },
};
