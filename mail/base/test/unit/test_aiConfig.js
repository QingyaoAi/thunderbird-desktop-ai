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

const PROFILE = "default";

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
