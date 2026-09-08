import { expect, it } from "vitest";
import config, { nativeTimeouts } from "../vitest.config.js";

it("uses bounded Windows test and hook deadlines without changing POSIX defaults or discovery", () => {
  expect(nativeTimeouts("win32")).toEqual({ testTimeout: 120_000, hookTimeout: 120_000 });
  expect(nativeTimeouts("darwin")).toEqual({});
  expect(nativeTimeouts("linux")).toEqual({});
  expect(config.test).toEqual(nativeTimeouts(process.platform));
  expect(config.test).not.toHaveProperty("include");
  expect(config.test).not.toHaveProperty("exclude");
});
