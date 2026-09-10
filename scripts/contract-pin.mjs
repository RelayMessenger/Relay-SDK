#!/usr/bin/env node
// The skill lock (skills/relay/references/relay-v1-lock.json) names one public
// commit, `api.public_source.commit`, that an installed coding agent fetches to
// read the contract. That commit has to outlive the branch it was made on.
// This repository squash-merges, so a PR-branch commit is dropped at merge and
// the pin points at nothing (2026-09-10, runs 34429666418 and 34429666441 on
// 7c13bac: pin 0b55bb2 existed on one machine only). A durable pin is therefore
// one reachable from origin/main, origin/staging, or the tag
// `contract/<first 8 of api.openapi_sha256>`, which a contract-change PR pushes
// once with this script so its commit survives the squash by name.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCK_PATH = "skills/relay/references/relay-v1-lock.json";
export const contractTag = (sha256) => `contract/${sha256.slice(0, 8)}`;

const git = (root, args, options = {}) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
const revParse = (root, ref) => {
  const result = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return result.status === 0 ? result.stdout.trim() : undefined;
};

/** The refs a pin may be reached from. Remote-tracking refs only: a local
 * branch proves nothing about what the public mirror carries. */
export const durableRefs = (sha256) => ["refs/remotes/origin/main", "refs/remotes/origin/staging", `refs/tags/${contractTag(sha256)}`];

/**
 * Is `commit` reachable from a durable ref in this checkout? Returns
 * `{ checked: false }` when the checkout has none of the refs at all (a packed
 * tarball, a shallow clone), so the caller can say the check was skipped
 * rather than fail on a machine that cannot know.
 */
export const pinReachability = ({ root, commit, sha256 }) => {
  const present = durableRefs(sha256).filter((ref) => revParse(root, ref));
  if (!present.length) {
    return { checked: false, present, message: `skill lock: none of ${durableRefs(sha256).join(", ")} exist in this checkout, so whether ${commit} is a durable public pin was not checked` };
  }
  const from = present.filter((ref) => git(root, ["merge-base", "--is-ancestor", commit, ref]).status === 0);
  if (from.length) return { checked: true, reachable: true, present, from };
  return {
    checked: true, reachable: false, present, from,
    message: `skill lock api.public_source.commit ${commit} is not reachable from ${present.join(", ")};`
      + ` this repository squash-merges, so a PR-branch commit vanishes at merge.`
      + ` Pin a commit that carries the locked contract and push the tag ${contractTag(sha256)} at it: node scripts/contract-pin.mjs`,
  };
};

const fileSha256 = (root, ref, path) => {
  const result = git(root, ["show", `${ref}:${path}`], { encoding: "buffer" });
  return result.status === 0 ? createHash("sha256").update(result.stdout).digest("hex") : undefined;
};

/** Run as a command: print the commit the lock should pin; tag and push HEAD when it carries the locked contract and no tag exists yet. */
const main = () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const lock = JSON.parse(readFileSync(resolve(root, LOCK_PATH), "utf8"));
  const { openapi_sha256: sha256, public_source: source } = lock.api;
  const tag = contractTag(sha256);
  git(root, ["fetch", "--quiet", "origin", `+refs/tags/${tag}:refs/tags/${tag}`]);
  const tagged = revParse(root, `refs/tags/${tag}`);
  if (tagged) {
    const digest = fileSha256(root, tagged, source.path);
    if (digest !== sha256) throw new Error(`tag ${tag} points at ${tagged}, whose ${source.path} hashes ${digest}, not the locked ${sha256}; move the tag by hand after reading why`);
    console.log(JSON.stringify({ pin: tagged, tag, pushed: false, reason: "tag already exists", current_pin: source.commit, current_pin_ok: source.commit === tagged || pinReachability({ root, commit: source.commit, sha256 }).reachable === true }));
    return;
  }
  const head = revParse(root, "HEAD");
  const digest = fileSha256(root, "HEAD", source.path);
  if (digest !== sha256) throw new Error(`HEAD ${head} carries ${source.path} at ${digest}, but the lock says ${sha256}; update the lock (api.openapi_sha256 and every copy) first, then run this again`);
  const created = git(root, ["tag", "-a", tag, head, "-m", `Relay v1 contract ${sha256}`]);
  if (created.status !== 0) throw new Error(created.stderr);
  const pushed = git(root, ["push", "origin", `refs/tags/${tag}`]);
  if (pushed.status !== 0) throw new Error(pushed.stderr);
  console.log(JSON.stringify({ pin: head, tag, pushed: true, current_pin: source.commit, current_pin_ok: source.commit === head }));
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
