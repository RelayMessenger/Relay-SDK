import { emitKeypressEvents } from "node:readline";
import type { ReadStream } from "node:tty";

/** Reads the token straight from the terminal: nothing is echoed, nothing is kept in history,
 * and no message ever contains the token. */
export async function readHiddenToken(
  input: ReadStream = process.stdin,
  writePrompt: (text: string) => void = (text) => { process.stderr.write(text); },
): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Relay cannot ask for a token here, because this is not a terminal. Pipe the token into npx relaymessenger auth login --with-token, or set RELAY_AGENT_TOKEN.");
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
    const ended = () => finish(new Error("Relay did not get a token: the input ended first."));
    const failed = () => finish(new Error("Relay did not get a token: reading from the terminal stopped."));
    const keypress = (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean } = {}) => {
      if (key.ctrl && (key.name === "c" || key.name === "d")) return finish(new Error("Relay did not get a token: you cancelled."));
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") { value = [...value].slice(0, -1).join(""); return; }
      if (key.ctrl && key.name === "u") { value = ""; return; }
      if (key.ctrl || key.meta || !text || /[\u0000-\u001f\u007f]/u.test(text)) return;
      value += text;
      if (value.length > 4096) finish(new Error("That token is too long. A Relay token is 52 characters."));
    };
    input.on("keypress", keypress);
    input.once("end", ended);
    input.once("error", failed);
    try { input.setRawMode(true); input.resume(); writePrompt("Paste your token (it stays hidden): "); }
    catch { finish(new Error("Relay did not get a token: it could not read from the terminal.")); }
  });
}
