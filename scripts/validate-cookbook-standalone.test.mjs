// The standalone check installs the channel of the branch it runs for:
// staging's `staging` dist-tag on the staging branch, main's `latest` release
// everywhere else. These are the environments GitHub Actions gives ci.yml.
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import {
  CHANNEL_TAGS,
  installedMismatch,
  publishedArguments,
  releaseDeferredPins,
  standaloneChannel,
  tarballArguments,
  unlockedReleaseCandidates,
  unpublishedReleaseRanges,
  waitForPublishedLatest,
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

test("release: an unlocked folder installs the release's own tarball, which the registry does not have yet", () => {
  const ranged = { field: "dependencies", name: "@relaymessenger/sdk", range: "^0.5.0" };
  const candidates = new Map([["@relaymessenger/sdk", { version: "0.5.0", path: "/r/relaymessenger-sdk-0.5.0.tgz" }]]);
  assert.deepEqual(unlockedReleaseCandidates({ channel: "release", locked: false, dependencies: [ranged], candidates }),
    [{ ...ranged, version: "0.5.0", path: "/r/relaymessenger-sdk-0.5.0.tgz" }]);
  // A locked folder installs what its lockfile pins, from the seeded cache.
  assert.deepEqual(unlockedReleaseCandidates({ channel: "release", locked: true, dependencies: [ranged], candidates }), []);
  // The staging channel and a run without tarballs keep the registry.
  assert.deepEqual(unlockedReleaseCandidates({ channel: "staging", locked: false, dependencies: [ranged], candidates }), []);
  assert.deepEqual(unlockedReleaseCandidates({ channel: "release", locked: false, dependencies: [ranged], candidates: new Map() }), []);
});

test("--tarball is repeatable and takes only .tgz paths", () => {
  assert.deepEqual(tarballArguments(["node", "x", "--tarball", "a/sdk-0.3.6.tgz", "--channel", "release", "--tarball", "/b/adapter-0.3.7.tgz"]),
    [resolve("a/sdk-0.3.6.tgz"), "/b/adapter-0.3.7.tgz"]);
  assert.deepEqual(tarballArguments(["node", "x"]), []);
  assert.throws(() => tarballArguments(["node", "x", "--tarball"]), /--tarball takes a .tgz path/u);
  assert.throws(() => tarballArguments(["node", "x", "--tarball", "sdk.tar"]), /--tarball takes a .tgz path/u);
});

test("release: an unlocked folder whose range names a version npm does not have yet is left to the release", () => {
  // A push to main runs this check while the release job is still publishing
  // 0.5.0: `^0.5.0` resolves to nothing (ETARGET) until it lands.
  const next = { field: "dependencies", name: "@relaymessenger/sdk", range: "^0.5.0" };
  const current = { field: "dependencies", name: "@relaymessenger/chat-sdk-adapter", range: "~0.3.7" };
  const exact = { field: "dependencies", name: "@relaymessenger/pi", range: "0.1.6" };
  const onNpm = new Set(["@relaymessenger/chat-sdk-adapter@0.3.7", "@relaymessenger/sdk@0.4.0"]);
  const isPublished = (name, version) => onNpm.has(`${name}@${version}`);
  assert.deepEqual(unpublishedReleaseRanges({ channel: "release", locked: false, dependencies: [next, current, exact], tarballs: [], isPublished }),
    [next, exact]);
  // Once npm has it, the folder is proven here again.
  onNpm.add("@relaymessenger/sdk@0.5.0");
  onNpm.add("@relaymessenger/pi@0.1.6");
  assert.deepEqual(unpublishedReleaseRanges({ channel: "release", locked: false, dependencies: [next, exact], tarballs: [], isPublished }), []);
  onNpm.delete("@relaymessenger/sdk@0.5.0");
  // The release's dry run installs its own tarballs; a locked folder installs its lockfile; staging installs staging builds.
  assert.deepEqual(unpublishedReleaseRanges({ channel: "release", locked: false, dependencies: [next], tarballs: ["/r/sdk.tgz"], isPublished }), []);
  assert.deepEqual(unpublishedReleaseRanges({ channel: "release", locked: true, dependencies: [next], tarballs: [], isPublished }), []);
  assert.deepEqual(unpublishedReleaseRanges({ channel: "staging", locked: false, dependencies: [next], tarballs: [], isPublished }), []);
  // A staging range is the release's `^0.5.0` once derived: left to the release until npm has 0.5.0.
  const staging = { field: "dependencies", name: "@relaymessenger/sdk", range: "^0.5.0-staging.0" };
  assert.deepEqual(unpublishedReleaseRanges({ channel: "release", locked: false, dependencies: [staging], tarballs: [], isPublished }), [staging]);
  onNpm.add("@relaymessenger/sdk@0.5.0");
  assert.deepEqual(unpublishedReleaseRanges({ channel: "release", locked: false, dependencies: [staging], tarballs: [], isPublished }), []);
  // An exact staging pin is releaseDeferredPins' to leave, not this one's.
  const exactStaging = { field: "dependencies", name: "@relaymessenger/sdk", range: "0.5.0-staging.4" };
  assert.deepEqual(unpublishedReleaseRanges({ channel: "release", locked: false, dependencies: [exactStaging], tarballs: [], isPublished }), []);
});

test("after a publish the check waits until npm installs the released version as latest, within the shared budget", async () => {
  const reads = [];
  const answers = [
    { latest: "0.4.0", versions: ["0.4.0"] },
    { latest: "0.4.0", versions: ["0.4.0", "0.5.0"] },
    { latest: "0.5.0", versions: ["0.4.0", "0.5.0"] },
  ];
  const waits = [];
  await waitForPublishedLatest({
    specs: [{ name: "@relaymessenger/sdk", version: "0.5.0" }],
    read: async (name) => { reads.push(name); return answers.shift(); },
    maxAttempts: 5,
    retryDelayMs: 7,
    sleep: async (ms) => { waits.push(ms); },
    say: () => undefined,
  });
  assert.equal(reads.length, 3);
  assert.deepEqual(waits, [7, 7]);
  await assert.rejects(
    waitForPublishedLatest({
      specs: [{ name: "@relaymessenger/sdk", version: "0.5.0" }],
      read: async () => ({ latest: "0.4.0", versions: ["0.4.0"] }),
      maxAttempts: 3,
      retryDelayMs: 1,
      sleep: async () => undefined,
      say: () => undefined,
    }),
    /@relaymessenger\/sdk@0\.5\.0 is not npm's latest after 3 reads \(latest 0\.4\.0, not listed\)/u,
  );
});

test("--published is repeatable and takes name@version", () => {
  assert.deepEqual(publishedArguments(["node", "x", "--published", "@relaymessenger/sdk@0.5.0", "--channel", "release", "--published", "relaymessenger@0.1.16"]),
    [{ name: "@relaymessenger/sdk", version: "0.5.0" }, { name: "relaymessenger", version: "0.1.16" }]);
  assert.deepEqual(publishedArguments(["node", "x"]), []);
  assert.throws(() => publishedArguments(["node", "x", "--published", "@relaymessenger/sdk"]), /--published takes name@version/u);
});
