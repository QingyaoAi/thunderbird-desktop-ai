/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests for AIConfig: the JSON config file, and API keys in the login
 * manager.
 *
 * The point of separating those two is that the key must never end up
 * somewhere it could be committed or read as plain text, so the assertions
 * below check both that keys round-trip through the login manager and that
 * they stay out of the config file.
 */

const { AIConfig } = ChromeUtils.importESModule(
  "resource:///modules/AIConfig.sys.mjs"
);
const { AIFormat } = ChromeUtils.importESModule(
  "resource:///modules/AIProvider.sys.mjs"
);

const PROFILE = "deepseek-v4-flash";

add_setup(async function () {
  do_get_profile();
});

registerCleanupFunction(async function () {
  await AIConfig.clearApiKey(PROFILE);
});

add_task(async function test_defaults_written_on_first_read() {
  const config = await AIConfig.read();

  Assert.equal(
    config.activeProfile,
    PROFILE,
    "a fresh profile selects the default config profile"
  );
  Assert.ok(config.profiles[PROFILE], "the default profile is defined");
  Assert.equal(
    config.profiles[PROFILE].format,
    AIFormat.OPENAI,
    "the default profile has a known format"
  );

  const path = PathUtils.join(PathUtils.profileDir, AIConfig.CONFIG_FILENAME);
  Assert.ok(
    await IOUtils.exists(path),
    "the config file was written out on first read"
  );
});

add_task(async function test_partial_config_merges_over_defaults() {
  // A user editing the file by hand will not repeat every field, so a
  // profile that only sets `model` still has to end up with a usable
  // baseUrl and format.
  await AIConfig.save({
    activeProfile: "local",
    profiles: { local: { model: "some-local-model" } },
  });
  AIConfig.reload();

  const profile = await AIConfig.activeProfile();
  Assert.equal(profile.name, "local", "the selected profile is active");
  Assert.equal(profile.model, "some-local-model", "the override is kept");
  Assert.ok(profile.baseUrl, "baseUrl is filled in from the defaults");
  Assert.ok(profile.format, "format is filled in from the defaults");
});

add_task(async function test_missing_active_profile_is_reported() {
  await AIConfig.save({ activeProfile: "nope", profiles: {} });
  AIConfig.reload();

  await Assert.rejects(
    AIConfig.activeProfile(),
    /does not define/,
    "selecting an undefined profile explains the problem"
  );

  // Put it back for the remaining tests.
  await AIConfig.save(AIConfig.DEFAULT_CONFIG);
  AIConfig.reload();
});

add_task(async function test_api_key_round_trip() {
  Assert.equal(
    await AIConfig.getApiKey(PROFILE),
    null,
    "no key is stored to begin with"
  );

  await AIConfig.setApiKey(PROFILE, "sk-test-value-one");
  Assert.equal(
    await AIConfig.getApiKey(PROFILE),
    "sk-test-value-one",
    "the stored key comes back"
  );

  // Setting again replaces rather than accumulating, otherwise repeated
  // edits would leave several logins and the wrong one could win.
  await AIConfig.setApiKey(PROFILE, "sk-test-value-two");
  Assert.equal(
    await AIConfig.getApiKey(PROFILE),
    "sk-test-value-two",
    "setting a second time replaces the first"
  );

  const logins = await Services.logins.searchLoginsAsync({
    origin: "chrome://messenger/ai",
    httpRealm: "chrome://messenger/ai",
  });
  Assert.equal(
    logins.filter(l => l.username == PROFILE).length,
    1,
    "exactly one login is stored for the profile"
  );

  await AIConfig.clearApiKey(PROFILE);
  Assert.equal(
    await AIConfig.getApiKey(PROFILE),
    null,
    "the key can be forgotten"
  );
});

add_task(async function test_keys_are_kept_per_profile() {
  await AIConfig.setApiKey("default", "sk-for-default");
  await AIConfig.setApiKey("local", "sk-for-local");

  Assert.equal(await AIConfig.getApiKey("default"), "sk-for-default");
  Assert.equal(await AIConfig.getApiKey("local"), "sk-for-local");

  await AIConfig.clearApiKey("local");
  Assert.equal(
    await AIConfig.getApiKey("default"),
    "sk-for-default",
    "clearing one profile's key leaves the other alone"
  );
  await AIConfig.clearApiKey("default");
});

add_task(async function test_key_never_reaches_the_config_file() {
  await AIConfig.save(AIConfig.DEFAULT_CONFIG);
  AIConfig.reload();
  await AIConfig.setApiKey(PROFILE, "sk-must-not-be-written");

  const path = PathUtils.join(PathUtils.profileDir, AIConfig.CONFIG_FILENAME);
  const text = await IOUtils.readUTF8(path);

  Assert.ok(
    !text.includes("sk-must-not-be-written"),
    "the API key is absent from the config file"
  );
  Assert.ok(
    !/api[_-]?key/i.test(text),
    "the config file has no field that invites pasting a key into it"
  );

  await AIConfig.clearApiKey(PROFILE);
});

add_task(async function test_isConfigured_requires_a_key() {
  await AIConfig.save(AIConfig.DEFAULT_CONFIG);
  AIConfig.reload();

  Assert.equal(
    await AIConfig.isConfigured(),
    false,
    "without a key we are not configured, so the panel stays off"
  );

  await AIConfig.setApiKey(PROFILE, "sk-something");
  Assert.equal(
    await AIConfig.isConfigured(),
    true,
    "with a key we are configured"
  );

  const options = await AIConfig.requestOptions();
  Assert.equal(options.apiKey, "sk-something", "request options carry the key");
  Assert.ok(options.baseUrl && options.model, "and the endpoint details");

  await AIConfig.clearApiKey(PROFILE);
  await Assert.rejects(
    AIConfig.requestOptions(),
    /No API key is stored/,
    "requesting options without a key explains what to do"
  );
});

add_task(async function test_only_one_endpoint_is_shipped() {
  await AIConfig.save(AIConfig.DEFAULT_CONFIG);
  AIConfig.reload();

  const profiles = await AIConfig.listProfiles();
  Assert.deepEqual(
    profiles.map(p => p.name),
    [PROFILE],
    "nothing is preset beyond the one endpoint, since the rest would be a guess"
  );
  Assert.ok(profiles[0].active, "and it is the one in use");
});

add_task(async function test_adding_an_endpoint_selects_it() {
  await AIConfig.addProfile({
    name: "My Claude",
    format: AIFormat.ANTHROPIC,
    baseUrl: "https://api.anthropic.com/",
    model: "claude-opus-5",
  });

  const active = await AIConfig.activeProfile();
  Assert.equal(active.name, "My Claude", "adding one is how you choose it");
  Assert.equal(active.format, AIFormat.ANTHROPIC, "the format is kept");
  Assert.equal(
    active.baseUrl,
    "https://api.anthropic.com",
    "a trailing slash is trimmed, since the paths are joined onto this"
  );
  Assert.equal(active.model, "claude-opus-5", "the model is kept");
  Assert.equal(active.maxTokens, 2048, "and the fields not asked for default");

  // Written through, so the choice survives a restart.
  AIConfig.reload();
  Assert.equal((await AIConfig.activeProfile()).name, "My Claude");
});

add_task(async function test_switching_changes_what_requests_use() {
  await AIConfig.setActiveProfile(PROFILE);
  Assert.equal(
    (await AIConfig.activeProfile()).model,
    "deepseek-v4-flash",
    "switching back changes which model requests go to"
  );

  await AIConfig.setActiveProfile("My Claude");
  Assert.equal((await AIConfig.activeProfile()).model, "claude-opus-5");
});

add_task(async function test_removing_an_endpoint_falls_back() {
  await AIConfig.setApiKey("My Claude", "sk-claude");
  await AIConfig.removeProfile("My Claude");

  const profiles = await AIConfig.listProfiles();
  Assert.ok(!profiles.some(p => p.name == "My Claude"), "the profile is gone");
  Assert.equal(
    (await AIConfig.activeProfile()).name,
    PROFILE,
    "and something else is active, rather than a dangling selection"
  );
  Assert.equal(
    await AIConfig.getApiKey("My Claude"),
    null,
    "its key goes with it, rather than being left in the login manager"
  );
});

add_task(async function test_an_incomplete_endpoint_is_refused() {
  await Assert.rejects(
    AIConfig.addProfile({ name: "Half", format: AIFormat.OPENAI }),
    /needs a name, format, base URL and model/,
    "a profile missing what a request needs is refused"
  );
  await Assert.rejects(
    AIConfig.addProfile({
      name: "Odd",
      format: "smoke-signals",
      baseUrl: "https://example.com",
      model: "m",
    }),
    /not a wire format/,
    "and so is one this cannot speak to"
  );
});

/**
 * Anthropic's current models reject `temperature` outright, so a value set in
 * a shipped profile would break it rather than tune it.
 */
add_task(async function test_shipped_profile_leaves_temperature_unset() {
  const config = await AIConfig.read();
  for (const [name, profile] of Object.entries(config.profiles)) {
    Assert.equal(
      profile.temperature,
      undefined,
      `the ${name} profile should not set a temperature`
    );
  }
});

add_task(async function test_old_default_profile_is_renamed() {
  // What a file written before the rename looks like, key and all.
  await AIConfig.save({
    activeProfile: "default",
    profiles: {
      default: {
        label: "DeepSeek (OpenAI-compatible)",
        format: AIFormat.OPENAI,
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
      },
    },
  });
  await AIConfig.setApiKey("default", "sk-carried-over");
  AIConfig.reload();

  const profiles = await AIConfig.listProfiles();
  Assert.deepEqual(
    profiles.map(p => p.name),
    [PROFILE],
    "the old name is gone rather than sitting beside the shipped one"
  );
  Assert.equal(
    (await AIConfig.activeProfile()).name,
    PROFILE,
    "and the selection followed it"
  );
  Assert.equal(
    await AIConfig.getApiKey(PROFILE),
    "sk-carried-over",
    "the key moved too, or the profile would ask for one it already has"
  );
  Assert.equal(
    await AIConfig.getApiKey("default"),
    null,
    "and is not left behind under the old name"
  );

  await AIConfig.clearApiKey(PROFILE);
});

add_task(async function test_a_repurposed_default_is_left_alone() {
  // Someone who pointed "default" at something else has two real profiles,
  // and calling one of them DeepSeek would be a lie rather than a tidy-up.
  await AIConfig.save({
    activeProfile: "default",
    profiles: {
      default: {
        label: "Something else",
        format: AIFormat.OPENAI,
        baseUrl: "https://api.example.com/v1",
        model: "some-model",
      },
    },
  });
  AIConfig.reload();

  const profiles = (await AIConfig.listProfiles()).map(p => p.name).sort();
  Assert.deepEqual(
    profiles,
    [PROFILE, "default"],
    "it stays as it is, beside the shipped profile"
  );
  Assert.equal(
    (await AIConfig.activeProfile()).baseUrl,
    "https://api.example.com/v1",
    "and is still the one selected"
  );
});

add_task(async function test_the_interim_name_is_renamed_too() {
  // The shipped profile was briefly keyed "deepseek" before being keyed for
  // its model, so a file written in between needs the same treatment.
  await AIConfig.save({
    activeProfile: "deepseek",
    profiles: {
      deepseek: {
        label: "DeepSeek (OpenAI-compatible)",
        format: AIFormat.OPENAI,
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
      },
    },
  });
  AIConfig.reload();

  const profiles = await AIConfig.listProfiles();
  Assert.deepEqual(
    profiles.map(p => p.name),
    [PROFILE],
    "the interim name is renamed rather than kept beside the shipped one"
  );
  Assert.equal(
    profiles[0].label,
    PROFILE,
    "and is relabelled, since the old label named the provider not the model"
  );
});
