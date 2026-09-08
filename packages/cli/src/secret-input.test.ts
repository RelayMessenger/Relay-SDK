import { PassThrough } from "node:stream";
import type { ReadStream } from "node:tty";
import { describe, expect, it, vi } from "vitest";
import { readHiddenToken } from "./secret-input.js";
import { aclChildEnvironment } from "./runtime-connect/windows-acl.js";

function terminal() {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode: (raw: boolean) => typeof input };
  input.isTTY = true; input.isRaw = false;
  input.setRawMode = vi.fn((raw: boolean) => { input.isRaw = raw; return input; });
  return input;
}
describe("private token prompt", () => {
  it("reads edited input without echo or history output and restores terminal mode", async () => {
    const input = terminal(); const output: string[] = [];
    const answer = readHiddenToken(input as unknown as ReadStream, (s) => output.push(s));
    input.write("private-tokeX"); input.write("\x7f"); input.write("n"); input.write("\r");
    expect(await answer).toBe("private-token");
    expect(output.join("")).toBe("Paste your token (it stays hidden): \n");
    expect(input.isRaw).toBe(false);
    input.destroy();
  });
  it("cancels without exposing partial input and restores raw mode", async () => {
    const input = terminal(); const output: string[] = [];
    const answer = readHiddenToken(input as unknown as ReadStream, (s) => output.push(s));
    input.write("partial-secret\x03");
    await expect(answer).rejects.toThrow("cancelled");
    expect(output.join("")).not.toContain("partial-secret");
    expect(input.isRaw).toBe(false);
    input.destroy();
  });
  it("rejects non-TTY input instead of attempting an echoed prompt", async () => {
    const input = terminal(); input.isTTY = false;
    await expect(readHiddenToken(input as unknown as ReadStream)).rejects.toThrow("--with-token");
    expect(input.setRawMode).not.toHaveBeenCalled(); input.destroy();
  });
});

it("removes PowerShell module paths only from the child environment, case-insensitively", () => {
  const parent = { PSModulePath: "pwsh7-modules", PSMODULEPATH: "alternate-case", PATH: "keep", RELAY_AGENT_TOKEN: "private-env" };
  const before = { ...parent };
  const child = aclChildEnvironment(parent, '{"action":"inspect"}');
  expect(Object.keys(child).some((key) => key.toLowerCase() === "psmodulepath")).toBe(false);
  expect(child.PATH).toBe("keep"); expect(child.RELAY_CONNECT_ACL).toBe('{"action":"inspect"}');
  expect(parent).toEqual(before);
});
