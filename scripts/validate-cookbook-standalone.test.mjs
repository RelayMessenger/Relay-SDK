// The standalone check installs the channel of the branch it runs for:
// staging's `staging` dist-tag on the staging branch, main's `latest` release
// everywhere else. These are the environments GitHub Actions gives ci.yml.
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import {
  CHANNEL_TAGS,
  installedMismatch,
  releaseDeferredPins,
  standaloneChannel,
  tarballArguments,
} from "./validate-cookbook-standalone.mjs";

const sdk = { field: "dependencies", name: "@relaymessenger/sdk", range: "^0.3.0-staging.0" };

test("a push to staging, a pull request into staging, and a dispatch on staging install the staging dist-tag", () => {
  for (const env of [
    { GITHUB_BASE_REF: "", GITHUB_REF: "refs/heads/staging" },
    { GITHUB_BASE_REF: "staging", GITHUB_REF: "refs/pull/390/merge" },
    { GITHUB_REF: "refs/heads/staging" },
  ]) {
    const { channel } = standaloneChannel(env, []);
    assert.equal(channel, "staging", JSON.stringify(env));
    assert.equal(CHANNEL_TAGS[channel], "staging");
  }
});

test("a push to main, a pull request into main, other branches, and no CI keep the release channel", () => {
  for (const env of [
    { GITHUB_BASE_REF: "", GITHUB_REF: "refs/heads/main" },
    { GITHUB_BASE_REF: "main", GITHUB_REF: "refs/pull/391/merge" },
    // A pull request from staging into main is checked as main.
    { GITHUB_BASE_REF: "main", GITHUB_HEAD_REF: "staging", GITHUB_REF: "refs/pull/392/merge" },
    { GITHUB_BASE_REF: "feat/other", GITHUB_REF: "refs/pull/393/merge" },
    { GITHUB_REF: "refs/heads/feat/think-payments-staging" },
    { GITHUB_REF: "refs/heads/staging-old" },
    {},
  ]) {
    const { channel } = standaloneChannel(env, []);
    assert.equal(channel, "release", JSON.stringify(env));
    assert.equal(CHANNEL_TAGS[channel], "latest");
  }
});

test("--channel names the channel outside CI and rejects anything else", () => {
  assert.equal(standaloneChannel({ GITHUB_REF: "refs/heads/main" }, ["--channel", "staging"]).channel, "staging");
  assert.equal(standaloneChannel({ GITHUB_REF: "refs/heads/staging" }, ["--channel", "release"]).channel, "release");
  assert.throws(() => standaloneChannel({}, ["--channel", "latest"]), /--channel takes release or staging/u);
});

test("release: a prerelease is refused, locked or not, and an unlocked folder must install latest", () => {
  const release = { channel: "release", dependency: sdk };
  assert.match(installedMismatch({ ...release, installed: "0.3.6-staging.46", locked: true }), /a prerelease/u);
  assert.match(installedMismatch({ ...release, installed: "0.3.6-staging.46", locked: false, tagged: "0.3.5" }), /a prerelease/u);
  assert.match(installedMismatch({ ...release, installed: "0.3.4", locked: false, tagged: "0.3.5" }), /npm latest is 0\.3\.5/u);
  assert.equal(installedMismatch({ ...release, installed: "0.3.5", locked: false, tagged: "0.3.5" }), null);
  assert.equal(installedMismatch({ ...release, installed: "0.3.0", locked: true }), null);
});

test("staging: an unlocked folder must install the staging dist-tag's build", () => {
  const staging = { channel: "staging", dependency: sdk, locked: false };
  assert.equal(installedMismatch({ ...staging, installed: "0.3.6-staging.46", tagged: "0.3.6-staging.46" }), null);
  assert.match(installedMismatch({ ...staging, installed: "0.3.5", tagged: "0.3.6-staging.46" }), /not a staging build/u);
  assert.match(installedMismatch({ ...staging, installed: "0.3.6-staging.45", tagged: "0.3.6-staging.46" }), /npm staging is 0\.3\.6-staging\.46/u);
});

test("staging: a locked folder installs what it pins, a release or a staging build, never another prerelease", () => {
  const locked = { channel: "staging", dependency: sdk, locked: true };
  assert.equal(installedMismatch({ ...locked, installed: "0.3.6-staging.46" }), null);
  assert.equal(installedMismatch({ ...locked, installed: "0.3.5" }), null);
  assert.match(installedMismatch({ ...locked, installed: "0.3.6-rc.1" }), /not a staging build/u);
});

test("release: an exact staging pin is left to the release, unless the release hands in its tarballs", () => {
  const exact = { field: "dependencies", name: "@relaymessenger/sdk", range: "0.3.6-staging.46" };
  const released = { field: "dependencies", name: "@relaymessenger/chat-sdk-adapter", range: "0.3.6" };
  assert.deepEqual(releaseDeferredPins({ channel: "release", dependencies: [exact, released, sdk], tarballs: [] }), [exact]);
  // A staging range installs a release and is proven here as before.
  assert.deepEqual(releaseDeferredPins({ channel: "release", dependencies: [sdk, released], tarballs: [] }), []);
  // The release's own run proves every folder from its packed tarballs.
  assert.deepEqual(releaseDeferredPins({ channel: "release", dependencies: [exact], tarballs: ["/r/sdk.tgz"] }), []);
  // The staging channel installs staging builds; nothing is deferred there.
  assert.deepEqual(releaseDeferredPins({ channel: "staging", dependencies: [exact], tarballs: [] }), []);
});

test("--tarball is repeatable and takes only .tgz paths", () => {
  assert.deepEqual(tarballArguments(["node", "x", "--tarball", "a/sdk-0.3.6.tgz", "--channel", "release", "--tarball", "/b/adapter-0.3.7.tgz"]),
    [resolve("a/sdk-0.3.6.tgz"), "/b/adapter-0.3.7.tgz"]);
  assert.deepEqual(tarballArguments(["node", "x"]), []);
  assert.throws(() => tarballArguments(["node", "x", "--tarball"]), /--tarball takes a .tgz path/u);
  assert.throws(() => tarballArguments(["node", "x", "--tarball", "sdk.tar"]), /--tarball takes a .tgz path/u);
});
