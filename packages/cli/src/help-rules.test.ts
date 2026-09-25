import type { Command } from "commander";
import { expect, it } from "vitest";
import { createProgram } from "./program.js";

const banned = /\b(?:simply|easily|just|seamless|powerful|simple|easy|robust|effortless|magical|blazing|phone number)\b/iu;
const products = /Relay Console|Claude Code|Gemini CLI|VS Code|OpenClaw|OpenCode|Relay|Codex|Hermes|Cursor|Cline|Pi/gu;

it("every help description fits the CLI help rules", () => {
  let commands = 0;
  let options = 0;
  let argumentsChecked = 0;
  const check = (text: string, limit: number, label: string): void => {
    expect(text.trim(), `${label}: missing description`).not.toBe("");
    expect(text.trim().split(/\s+/u).length, `${label}: at most ${limit} words: ${text}`).toBeLessThanOrEqual(limit);
    expect(text, `${label}: banned word`).not.toMatch(banned);
    expect(text, `${label}: trailing period`).not.toMatch(/\.$/u);
  };
  const walk = (command: Command, path: string): void => {
    commands++;
    check(command.description(), 9, path);
    const withoutProducts = command.description().replace(products, "product");
    expect(withoutProducts.split(/\s+/u).slice(1).join(" "), `${path}: lowercase after first word`).toBe(withoutProducts.split(/\s+/u).slice(1).join(" ").toLowerCase());
    for (const option of command.createHelp().visibleOptions(command)) {
      options++;
      check(option.description, option.long === "--subtitle" ? 8 : 7, `${path} ${option.flags}`);
    }
    // Hidden flags are still supported help descriptions and must obey the rules.
    for (const option of command.options.filter((option) => option.hidden)) {
      options++;
      check(option.description, option.long === "--subtitle" ? 8 : 7, `${path} ${option.flags}`);
    }
    for (const argument of command.registeredArguments) {
      argumentsChecked++;
      check(argument.description, 5, `${path} <${argument.name()}>`);
    }
    for (const child of command.commands) walk(child, `${path} ${child.name()}`);
  };
  walk(createProgram({}), "relaymessenger");
  process.stdout.write(`Help rules checked ${commands} commands, ${options} options, ${argumentsChecked} arguments\n`);
});
