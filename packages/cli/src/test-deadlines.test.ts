import { expect, it } from "vitest";
import config, { nativeTimeouts } from "../vitest.config.js";

it("uses bounded Windows test and hook deadlines without changing POSIX defaults or discovery", () => {
  expect(nativeTimeouts("win32")).toEqual({ testTimeout: 120_000, hookTimeout: 120_000 });
  expect(nativeTimeouts("darwin")).toEqual({});
  expect(nativeTimeouts("linux")).toEqual({});
  // The suite reads plain text: colour is off no matter what CI or the terminal says.
  expect(config.test).toEqual({ ...nativeTimeouts(process.platform), env: { NO_COLOR: "1" } });
  expect(config.test).not.toHaveProperty("include");
  expect(config.test).not.toHaveProperty("exclude");
});
