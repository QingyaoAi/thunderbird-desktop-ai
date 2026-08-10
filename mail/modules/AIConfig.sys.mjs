/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Where the AI panel's settings live, and -- separately -- where its API key
 * lives.
 *
 * Two storage locations, on purpose:
 *
 *   - Everything non-secret (base URL, model, format, limits) goes in
 *     `<profile>/ai-config.json`, so it can be read, diffed and edited by
 *     hand, and so a local or proxied endpoint needs no code change.
 *
 *   - The API key goes in the login manager, the same place Thunderbird
 *     keeps mail account passwords: encrypted at rest and covered by the
 *     primary password if one is set. It is deliberately NOT in the JSON
 *     and NOT in a pref. prefs.js is plain text, config files get committed
 *     by accident, and this repository is a public fork.
 */

import { AIFormat } from "resource:///modules/AIProvider.sys.mjs";

/** Config file name, inside the profile directory. */
const CONFIG_FILENAME = "ai-config.json";

/**
 * Pseudo-URL identifying our entries in the login manager. It is not a real
 * network origin; the login manager just needs a stable key, and mail
 * account credentials use their server URI the same way.
 */
const LOGIN_ORIGIN = "chrome://messenger/ai";

/**
 * Shipped defaults. A fresh profile gets this file written out on first
 * read, so there is something concrete to edit rather than a blank page.
 * There is no key here and no key is implied: until one is set, the panel
 * stays off and nothing is sent anywhere.
 */
const DEFAULT_CONFIG = {
  activeProfile: "default",
  profiles: {
    default: {
      label: "DeepSeek (OpenAI-compatible)",
      format: AIFormat.OPENAI,
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      maxTokens: 2048,
      // Left undefined so the provider's own default applies unless the
      // user opts into a specific value.
      temperature: undefined,
    },
  },
  // How much mail a single question may pull in as context. Trades cost and
  // latency against recall; see AIMailContext.
  context: {
    maxMessages: 12,
    maxCharsPerMessage: 4000,
    maxTotalChars: 60000,
  },
};

/**
 * @returns {string} Path to the config file, which may not exist yet.
 */
function configPath() {
  return PathUtils.join(PathUtils.profileDir, CONFIG_FILENAME);
}

/**
 * Merge a user's config over the defaults, one level into `profiles` and
 * `context` so a partial file doesn't wipe out unspecified fields.
 *
 * @param {object} userConfig
 * @returns {object}
 */
function mergeWithDefaults(userConfig) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...userConfig,
    context: { ...DEFAULT_CONFIG.context, ...(userConfig?.context ?? {}) },
    profiles: { ...DEFAULT_CONFIG.profiles, ...(userConfig?.profiles ?? {}) },
  };
  // Merge each profile over the shipped default profile too, so a user
  // profile that only overrides `model` still has a baseUrl and format.
  for (const [name, profile] of Object.entries(merged.profiles)) {
    merged.profiles[name] = { ...DEFAULT_CONFIG.profiles.default, ...profile };
  }
  return merged;
}

export const AIConfig = {
  /** Cached parsed config; cleared by save() and reload(). */
  _cache: null,

  /**
   * Read the configuration, writing out the defaults first if there is no
   * file yet.
   *
   * @returns {Promise<object>}
   */
  async read() {
    if (this._cache) {
      return this._cache;
    }

    const path = configPath();
    if (!(await IOUtils.exists(path))) {
      await this.save(DEFAULT_CONFIG);
      return this._cache;
    }

    let parsed;
    try {
      const text = await IOUtils.readUTF8(path);
      parsed = JSON.parse(text);
    } catch (ex) {
      // A broken config shouldn't leave the feature unusable, but silently
      // running on defaults would be confusing, so say so.
      console.error(
        `${CONFIG_FILENAME} could not be read and defaults are being used:`,
        ex
      );
      parsed = {};
    }

    this._cache = mergeWithDefaults(parsed);
    return this._cache;
  },

  /**
   * Write the configuration back out.
   *
   * @param {object} config
   * @returns {Promise<void>}
   */
  async save(config) {
    await IOUtils.writeUTF8(configPath(), JSON.stringify(config, null, 2));
    this._cache = mergeWithDefaults(config);
  },

  /** Drop the cache so the next read hits disk. */
  reload() {
    this._cache = null;
  },

  /**
   * The profile currently selected by `activeProfile`.
   *
   * @returns {Promise<object>} `{name, label, format, baseUrl, model, …}`.
   */
  async activeProfile() {
    const config = await this.read();
    const name = config.activeProfile;
    const profile = config.profiles?.[name];
    if (!profile) {
      throw new Error(
        `${CONFIG_FILENAME} selects the profile "${name}", which it does not define.`
      );
    }
    return { name, ...profile };
  },

  // -- API keys -----------------------------------------------------------
  //
  // Stored per config profile, so switching between, say, a hosted and a
  // local endpoint doesn't mean re-entering a key.

  /**
   * Store (or replace) the API key for a config profile.
   *
   * @param {string} profileName
   * @param {string} apiKey
   * @returns {Promise<void>}
   */
  async setApiKey(profileName, apiKey) {
    await this.clearApiKey(profileName);
    if (!apiKey) {
      return;
    }
    const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(
      Ci.nsILoginInfo
    );
    login.init(LOGIN_ORIGIN, null, LOGIN_ORIGIN, profileName, apiKey, "", "");
    await Services.logins.addLoginAsync(login);
  },

  /**
   * The API key for a config profile.
   *
   * @param {string} profileName
   * @returns {Promise<?string>} The key, or null if none is stored.
   */
  async getApiKey(profileName) {
    const logins = await Services.logins.searchLoginsAsync({
      origin: LOGIN_ORIGIN,
      httpRealm: LOGIN_ORIGIN,
    });
    return logins.find(l => l.username == profileName)?.password ?? null;
  },

  /**
   * Forget the API key for a config profile.
   *
   * @param {string} profileName
   * @returns {Promise<void>}
   */
  async clearApiKey(profileName) {
    const logins = await Services.logins.searchLoginsAsync({
      origin: LOGIN_ORIGIN,
      httpRealm: LOGIN_ORIGIN,
    });
    for (const login of logins) {
      if (login.username == profileName) {
        await Services.logins.removeLoginAsync(login);
      }
    }
  },

  /**
   * Whether the panel has everything it needs to make a request. Used to
   * keep the UI (and any network access) switched off until it does.
   *
   * @returns {Promise<boolean>}
   */
  async isConfigured() {
    try {
      const profile = await this.activeProfile();
      return Boolean(
        profile.baseUrl && profile.model && (await this.getApiKey(profile.name))
      );
    } catch {
      return false;
    }
  },

  /**
   * Everything needed for one request: the active profile plus its key.
   * Throws if unconfigured, so callers get a clear reason rather than an
   * opaque provider error.
   *
   * @returns {Promise<object>} Ready to spread into AIProvider.chat().
   */
  async requestOptions() {
    const profile = await this.activeProfile();
    const apiKey = await this.getApiKey(profile.name);
    if (!apiKey) {
      throw new Error(
        `No API key is stored for the "${profile.name}" profile. ` +
          `Add one before using the AI panel.`
      );
    }
    return {
      format: profile.format,
      baseUrl: profile.baseUrl,
      model: profile.model,
      maxTokens: profile.maxTokens,
      temperature: profile.temperature,
      apiKey,
    };
  },

  get CONFIG_FILENAME() {
    return CONFIG_FILENAME;
  },
  get DEFAULT_CONFIG() {
    return structuredClone(DEFAULT_CONFIG);
  },
};
