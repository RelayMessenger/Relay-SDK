/**
 * Relay's prompts, drawn on @clack/core the way @clack/prompts draws its own
 * (node_modules/@clack/prompts/dist/index.mjs: `select`, `confirm`, `text`,
 * `password`, `spinner`, `log`). The shapes, the glyphs and the gutter are
 * clack's; only the colours differ. clack paints the active option, the
 * finished step and the check in its own success hue with node's `styleText`, and nothing in
 * its settings changes that, so the render functions live here and paint
 * Relay blue instead (owner ruling, _artifacts/cli-connect-design-20260912.md,
 * item 7: Relay blue, dim and red, and no other hue anywhere).
 */
import { ConfirmPrompt, PasswordPrompt, SelectPrompt, TextPrompt, block, wrapTextWithPrefix, type State } from "@clack/core";
import {
  S_BAR, S_BAR_END, S_BAR_START, S_PASSWORD_MASK, S_RADIO_ACTIVE, S_RADIO_INACTIVE,
  S_STEP_ACTIVE, S_STEP_CANCEL, S_STEP_ERROR, S_STEP_SUBMIT, unicode,
} from "@clack/prompts";
import type { Readable, Writable } from "node:stream";
import type { Palette } from "./ui-colour.js";

export interface ThemeIO { input: Readable; output: Writable }
export interface SelectOption { value: string; label: string; hint?: string; dim?: boolean }

export interface Theme {
  /** `undefined` and clack's cancel symbol both mean the person left the question. */
  select(message: string, options: SelectOption[], initialValue?: string): Promise<string | symbol | undefined>;
  confirm(message: string, initialValue: boolean): Promise<boolean | symbol | undefined>;
  text(message: string, initialValue: string): Promise<string | symbol | undefined>;
  password(message: string): Promise<string | symbol | undefined>;
  intro(message: string): void;
  outro(message: string): void;
  /** A finished step: the diamond the prompts leave behind, in Relay blue. */
  step(message: string): void;
  /** A sentence inside the gutter that is neither a question nor a step. */
  message(message: string): void;
  spinner(): { start(message: string): void; stop(message: string): void };
}

export const makeTheme = (p: Palette, io: ThemeIO): Theme => {
  const bar = p.dim(S_BAR);
  const symbol = (state: State): string => {
    switch (state) {
      case "cancel": return p.red(S_STEP_CANCEL);
      case "error": return p.red(S_STEP_ERROR);
      case "submit": return p.blue(S_STEP_SUBMIT);
      default: return p.blue(S_STEP_ACTIVE);
    }
  };
  const activeBar = (state: State): string => state === "cancel" || state === "error" ? p.red(S_BAR) : p.blue(S_BAR);
  const title = (state: State, message: string): string =>
    `${bar}\n${wrapTextWithPrefix(io.output, message, `${activeBar(state)}  `, `${symbol(state)}  `)}\n`;
  const write = (text: string): void => { io.output.write(text); };

  return {
    select: (message, options, initialValue) => {
      const paint = (option: SelectOption | undefined, how: "active" | "inactive" | "selected" | "cancelled"): string => {
        if (!option) return "";
        const label = option.dim ? p.dim(option.label) : option.label;
        const hint = option.hint ? ` ${p.dim(`(${option.hint})`)}` : "";
        switch (how) {
          case "active": return `${p.blue(S_RADIO_ACTIVE)} ${label}${hint}`;
          case "selected": return p.dim(option.label);
          case "cancelled": return p.dim(option.label);
          default: return `${p.dim(S_RADIO_INACTIVE)} ${p.dim(option.label)}${hint}`;
        }
      };
      return new SelectPrompt<SelectOption>({
        options, ...(initialValue === undefined ? {} : { initialValue }), ...io,
        render() {
          const head = title(this.state, message);
          const chosen = this.options[this.cursor];
          switch (this.state) {
            case "submit": return `${head}${bar}  ${paint(chosen, "selected")}`;
            case "cancel": return `${head}${bar}  ${paint(chosen, "cancelled")}\n${bar}`;
            default: {
              const gutter = `${p.blue(S_BAR)}  `;
              const rows = this.options.map((option, index) => paint(option, index === this.cursor ? "active" : "inactive"));
              return `${head}${gutter}${rows.join(`\n${gutter}`)}\n${p.blue(S_BAR_END)}\n`;
            }
          }
        },
      }).prompt();
    },
    confirm: (message, initialValue) => new ConfirmPrompt({
      active: "Yes", inactive: "No", initialValue, ...io,
      render() {
        // fly's "(Y/n)": the default is the capital, and Enter takes it.
        const head = title(this.state, `${message} ${p.dim(initialValue ? "(Y/n)" : "(y/N)")}`);
        const answer = this.value ? "Yes" : "No";
        switch (this.state) {
          case "submit": return `${head}${bar}  ${p.dim(answer)}`;
          case "cancel": return `${head}${bar}  ${p.dim(answer)}\n${bar}`;
          default: {
            const yes = this.value ? `${p.blue(S_RADIO_ACTIVE)} Yes` : `${p.dim(S_RADIO_INACTIVE)} ${p.dim("Yes")}`;
            const no = this.value ? `${p.dim(S_RADIO_INACTIVE)} ${p.dim("No")}` : `${p.blue(S_RADIO_ACTIVE)} No`;
            return `${head}${p.blue(S_BAR)}  ${yes} ${p.dim("/")} ${no}\n${p.blue(S_BAR_END)}\n`;
          }
        }
      },
    }).prompt(),
    text: (message, initialValue) => new TextPrompt({
      initialValue, ...io,
      render() {
        const head = title(this.state, message);
        const value = this.value ?? "";
        switch (this.state) {
          case "submit": return `${head}${bar}${value ? `  ${p.dim(value)}` : ""}`;
          case "cancel": return `${head}${bar}${value ? `  ${p.dim(value)}` : ""}${value.trim() ? `\n${bar}` : ""}`;
          case "error": return `${head.trim()}\n${p.red(S_BAR)}  ${this.userInputWithCursor}\n${p.red(S_BAR_END)}  ${p.red(this.error)}\n`;
          default: return `${head}${p.blue(S_BAR)}  ${this.userInputWithCursor}\n${p.blue(S_BAR_END)}\n`;
        }
      },
    }).prompt(),
    password: (message) => new PasswordPrompt({
      mask: S_PASSWORD_MASK, ...io,
      render() {
        const head = title(this.state, message);
        const masked = this.masked ?? "";
        switch (this.state) {
          case "submit": return `${head}${bar}  ${p.dim(masked)}`;
          case "cancel": return `${head}${bar}  ${p.dim(masked)}${masked ? `\n${bar}` : ""}`;
          case "error": return `${head.trim()}\n${p.red(S_BAR)}  ${masked}\n${p.red(S_BAR_END)}  ${p.red(this.error)}\n`;
          default: return `${head}${p.blue(S_BAR)}  ${this.userInputWithCursor}\n${p.blue(S_BAR_END)}\n`;
        }
      },
    }).prompt(),
    intro: (message) => write(`${p.dim(S_BAR_START)}  ${message}\n`),
    outro: (message) => write(`${bar}\n${p.dim(S_BAR_END)}  ${message}\n\n`),
    step: (message) => write(`${bar}\n${p.blue(S_STEP_SUBMIT)}  ${message.split("\n").join(`\n${bar}  `)}\n`),
    message: (message) => write(`${bar}\n${bar}  ${message.split("\n").join(`\n${bar}  `)}\n`),
    spinner: () => {
      const frames = unicode ? ["◒", "◐", "◓", "◑"] : ["•", "o", "O", "0"];
      let timer: NodeJS.Timeout | undefined;
      let unblock: (() => void) | undefined;
      let text = "";
      let painted = false;
      const clear = (): void => { if (painted) write("[1G[0J"); painted = false; };
      const paint = (frame: string, dots: string): void => { clear(); write(`${p.blue(frame)}  ${text}${dots}`); painted = true; };
      return {
        start: (message) => {
          text = message.replace(/\.+$/u, "");
          unblock = block({ output: io.output });
          write(`${bar}\n`);
          let index = 0; let dots = 0;
          paint(frames[0]!, "");
          timer = setInterval(() => {
            index = (index + 1) % frames.length; dots = (dots + 1) % 32;
            paint(frames[index]!, ".".repeat(Math.floor(dots / 8)));
          }, unicode ? 80 : 120);
        },
        stop: (message) => {
          if (timer) clearInterval(timer); timer = undefined;
          clear();
          write(`${p.blue(S_STEP_SUBMIT)}  ${message || text}\n`);
          unblock?.(); unblock = undefined;
        },
      };
    },
  };
};
