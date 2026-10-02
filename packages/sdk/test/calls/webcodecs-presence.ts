import { createRequire } from "node:module";
import { loadWebCodecs } from "../../src/calls/engine-werift-video.js";

/**
 * Whether the optional node-webcodecs is installed beside the SDK, and
 * whether its native binding loads. npm drops it where 1.3.0 ships no build
 * (Windows among them), and an install can omit optional packages anywhere,
 * so tests ask the installed tree, not the platform.
 */
export const WEBCODECS_PACKAGE = (() => {
  try {
    createRequire(import.meta.url).resolve("node-webcodecs/package.json");
    return true;
  } catch {
    return false;
  }
})();

export const WEBCODECS_NATIVE = await loadWebCodecs().then(() => true, () => false);

/** What Relay video says when node-webcodecs cannot be loaded (loadWebCodecs). */
export const MISSING_WEBCODECS = /Relay video needs the optional dependency node-webcodecs/u;
