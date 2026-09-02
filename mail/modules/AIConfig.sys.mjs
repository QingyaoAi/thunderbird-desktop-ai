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
  // One entry per endpoint worth switching between. The set is small on
  // purpose: these are the ones whose base URL and model name are known to
  // be right, and anything else is a few lines added to ai-config.json,
  // which is read the same way.
  //
  // Note on temperature: it is left undefined throughout, and that is not
  // only a matter of deferring to the provider. Anthropic's current models
  // reject the field outright with a 400, so a value set here would break
  // those profiles rather than tune them.
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
    claude: {
      label: "Claude (Anthropic)",
      format: AIFormat.ANTHROPIC,
      baseUrl: "https://api.anthropic.com",
      model: "claude-opus-5",
      maxTokens: 4096,
      temperature: undefined,
    },
    "claude-fast": {
      label: "Claude Haiku (Anthropic)",
      format: AIFormat.ANTHROPIC,
      baseUrl: "https://api.anthropic.com",
      model: "claude-haiku-4-5",
      maxTokens: 4096,
      temperature: undefined,
    },
    local: {
      // Ollama and LM Studio both answer the OpenAI shape on this port. The
      // model name is whatever has been pulled locally, so it is left as
      // something plainly wrong rather than a guess that fails obscurely.
      label: "Local (OpenAI-compatible)",
      format: AIFormat.OPENAI,
      baseUrl: "http://localhost:11434/v1",
      model: "set-me-in-ai-config.json",
      maxTokens: 2048,
      temperature: undefined,
    },
  },
  // How much mail a single question may pull in as context. Trades cost and
  // latency against recall; see AIMailContext.
  context: {
    // Retrieval works in threads: maxMessages caps how many search hits are
    // considered, maxThreads how many whole conversations are actually
    // read. Per-message is lower than it was, because a thread now
    // contributes every message rather than one.
    maxMessages: 12,
    maxThreads: 6,
    maxCharsPerMessage: 2500,
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

  /**
   * Every profile, in the order they appear in the file, with the active one
   * marked. For a switcher, which needs to show what is there rather than
   * only what is chosen.
   *
   * @returns {Promise<Array<{name: string, label: string, active: boolean}>>}
   */
  async listProfiles() {
    const config = await this.read();
    return Object.entries(config.profiles ?? {}).map(([name, profile]) => ({
      name,
      label: profile.label || name,
      active: name === config.activeProfile,
    }));
  },

  /**
   * Switch which profile requests go to.
   *
   * Writes the file rather than holding the choice in memory: a model picked
   * in the panel should still be the one in use tomorrow, and the file stays
   * the single account of what is configured.
   *
   * @param {string} name - A key of `profiles`.
   * @returns {Promise<void>}
   */
  async setActiveProfile(name) {
    const config = await this.read();
    if (!config.profiles?.[name]) {
      throw new Error(`No AI profile named "${name}" is configured.`);
    }
    if (config.activeProfile === name) {
      return;
    }
    await this.save({ ...config, activeProfile: name });
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
