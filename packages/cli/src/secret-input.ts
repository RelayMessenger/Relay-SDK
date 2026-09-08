import { emitKeypressEvents } from "node:readline";
import type { ReadStream } from "node:tty";

/** Raw TTY input with no echo, history, or token-bearing diagnostics. */
export async function readHiddenToken(
  input: ReadStream = process.stdin,
  writePrompt: (text: string) => void = (text) => { process.stderr.write(text); },
): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Interactive token input requires a terminal. Use --with-token with stdin or RELAY_AGENT_TOKEN.");
  }
  const wasRaw = input.isRaw;
  const wasFlowing = input.readableFlowing === true;
  emitKeypressEvents(input);
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      input.removeListener("keypress", keypress);
      input.removeListener("end", ended);
      input.removeListener("error", failed);
      try { input.setRawMode(wasRaw); } catch { /* The terminal may have closed. */ }
      if (!wasFlowing) input.pause();
      writePrompt("\n");
      const answer = value; value = "";
      if (error) reject(error); else resolve(answer);
    };
    const ended = () => finish(new Error("Token input ended without a token."));
    const failed = () => finish(new Error("Private token input failed."));
    const keypress = (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean } = {}) => {
      if (key.ctrl && (key.name === "c" || key.name === "d")) return finish(new Error("Token input cancelled."));
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") { value = [...value].slice(0, -1).join(""); return; }
      if (key.ctrl && key.name === "u") { value = ""; return; }
      if (key.ctrl || key.meta || !text || /[\u0000-\u001f\u007f]/u.test(text)) return;
      value += text;
      if (value.length > 4096) finish(new Error("Agent Token is too long."));
    };
    input.on("keypress", keypress);
    input.once("end", ended);
    input.once("error", failed);
    try { input.setRawMode(true); input.resume(); writePrompt("Agent Token (hidden): "); }
    catch { finish(new Error("Private token input could not start.")); }
  });
}
