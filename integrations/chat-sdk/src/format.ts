import { parseMarkdown, tableToAscii } from "chat";
import type { MdastTable, Nodes, Root } from "chat";
import type { RelayStyleRange, RelayTextStyle } from "./types.js";

/**
 * Relay does not render Markdown. A text part carries canonical plain text
 * plus optional `styles` runs, offsets in UTF-16 code units, and clients draw
 * the runs. So the conversion from the Chat SDK's mdast is not a stringify: it
 * flattens the tree to the text a person reads and records the emphasis it
 * carried as style ranges, which is the only path that keeps both the words
 * and the formatting.
 *
 * Constructs Relay has no style for keep their information in the text rather
 * than losing it: a link whose label differs from its target renders as
 * `label (url)`, a blockquote keeps a `> ` line prefix, and a table is drawn as
 * an ASCII grid whose column alignment survives in the characters themselves.
 */
export interface RenderedText {
  text: string;
  styles: RelayStyleRange[];
}

/** Relay accepts at most 200 style ranges on one text part. */
export const MAX_STYLE_RANGES = 200;

function sameStyles(left: RelayTextStyle[], right: RelayTextStyle[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((style, index) => style === right[index]);
}

class TextBuilder {
  private out = "";
  private runs: RelayStyleRange[] = [];

  get length(): number {
    return this.out.length;
  }

  append(value: string, styles: RelayTextStyle[]): void {
    if (!value) return;
    const start = this.out.length;
    this.out += value;
    if (styles.length > 0) {
      this.runs.push({ start, length: value.length, styles: [...styles] });
    }
  }

  /** Splice an already-rendered fragment, rebasing its style offsets. */
  appendRendered(rendered: RenderedText, styles: RelayTextStyle[]): void {
    if (!rendered.text) return;
    const base = this.out.length;
    this.out += rendered.text;
    if (styles.length > 0) {
      this.runs.push({
        start: base,
        length: rendered.text.length,
        styles: [...styles],
      });
    }
    for (const run of rendered.styles) {
      this.runs.push({
        start: base + run.start,
        length: run.length,
        styles: [...run.styles],
      });
    }
  }

  finish(): RenderedText {
    return { text: this.out, styles: normalizeStyles(this.runs) };
  }
}

/**
 * Collapse the raw run list into what Relay's contract requires: sorted by
 * start, non-overlapping, and no more than 200 entries. Nested emphasis
 * produces overlapping runs, so they are flattened onto a per-character style
 * set and then re-run-length-encoded.
 */
export function normalizeStyles(runs: RelayStyleRange[]): RelayStyleRange[] {
  if (runs.length === 0) return [];
  let end = 0;
  for (const run of runs) end = Math.max(end, run.start + run.length);
  const perCharacter: RelayTextStyle[][] = Array.from(
    { length: end },
    () => [] as RelayTextStyle[],
  );
  for (const run of runs) {
    for (let i = run.start; i < run.start + run.length; i += 1) {
      const slot = perCharacter[i];
      if (!slot) continue;
      for (const style of run.styles) {
        if (!slot.includes(style)) slot.push(style);
      }
    }
  }
  const merged: RelayStyleRange[] = [];
  let index = 0;
  while (index < end) {
    const styles = perCharacter[index] ?? [];
    if (styles.length === 0) {
      index += 1;
      continue;
    }
    let span = index + 1;
    while (span < end && sameStyles(perCharacter[span] ?? [], styles)) span += 1;
    merged.push({ start: index, length: span - index, styles: [...styles].sort() });
    index = span;
  }
  // Styles are presentation only, so an overflowing document keeps every word
  // and loses only the runs past Relay's ceiling.
  return merged.slice(0, MAX_STYLE_RANGES);
}

/**
 * Insert a prefix at the start of every line, remapping style offsets so the
 * runs still cover the same characters.
 */
export function prefixLines(
  rendered: RenderedText,
  prefix: string,
  firstPrefix: string = prefix,
): RenderedText {
  if (!rendered.text) return { text: firstPrefix, styles: [] };
  const map = new Array<number>(rendered.text.length + 1);
  let out = firstPrefix;
  let atLineStart = false;
  for (let i = 0; i < rendered.text.length; i += 1) {
    if (atLineStart) {
      out += prefix;
      atLineStart = false;
    }
    map[i] = out.length;
    const character = rendered.text[i] as string;
    out += character;
    if (character === "\n") atLineStart = true;
  }
  map[rendered.text.length] = out.length;
  const styles = rendered.styles.map((run) => {
    const start = map[run.start] as number;
    const stop = map[run.start + run.length] as number;
    return { start, length: stop - start, styles: run.styles };
  });
  return { text: out, styles };
}

function nodeText(node: Nodes): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node && Array.isArray(node.children)) {
    return (node.children as Nodes[]).map(nodeText).join("");
  }
  return "";
}

function renderInline(
  nodes: Nodes[],
  builder: TextBuilder,
  styles: RelayTextStyle[],
): void {
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        builder.append(node.value, styles);
        break;
      case "strong":
        renderInline(node.children as Nodes[], builder, [...styles, "bold"]);
        break;
      case "emphasis":
        renderInline(node.children as Nodes[], builder, [...styles, "italic"]);
        break;
      case "delete":
        renderInline(node.children as Nodes[], builder, [
          ...styles,
          "strikethrough",
        ]);
        break;
      case "inlineCode":
        // Relay's style set is bold | italic | underline | strikethrough, and
        // none of them is a fixed-width face. The closest surviving rendering
        // for code is therefore no run at all: the characters are what carry
        // code, and dressing them in a decoration Relay does have would say
        // something about the span that the author never wrote. Emphasis
        // already in scope still applies.
        builder.append(node.value, styles);
        break;
      case "break":
        builder.append("\n", []);
        break;
      case "link": {
        const label = nodeText(node);
        renderInline(node.children as Nodes[], builder, styles);
        // Relay has no link style, so the destination is written out rather
        // than dropped whenever the label does not already carry it.
        if (node.url && node.url !== label) builder.append(` (${node.url})`, []);
        break;
      }
      case "image": {
        const alt = node.alt ?? "";
        builder.append(alt ? `${alt} (${node.url})` : node.url, styles);
        break;
      }
      case "html":
        builder.append(node.value, styles);
        break;
      case "footnoteReference":
        builder.append(`[^${node.identifier}]`, styles);
        break;
      default: {
        if ("children" in node && Array.isArray(node.children)) {
          renderInline(node.children as Nodes[], builder, styles);
        } else if ("value" in node && typeof node.value === "string") {
          builder.append(node.value, styles);
        }
      }
    }
  }
}

function renderBlock(node: Nodes): RenderedText {
  switch (node.type) {
    case "paragraph": {
      const builder = new TextBuilder();
      renderInline(node.children as Nodes[], builder, []);
      return builder.finish();
    }
    case "heading": {
      const builder = new TextBuilder();
      renderInline(node.children as Nodes[], builder, ["bold"]);
      return builder.finish();
    }
    case "code": {
      // Same reasoning as `inlineCode`: Relay has no monospace style, so a
      // fenced block keeps its own line breaks and indentation verbatim and
      // takes no style run rather than being bolded or italicised whole.
      const builder = new TextBuilder();
      builder.append(node.value, []);
      return builder.finish();
    }
    case "blockquote": {
      const inner = renderBlocks(node.children as Nodes[]);
      return prefixLines(inner, "> ");
    }
    case "list": {
      const parts: RenderedText[] = [];
      let counter = node.start ?? 1;
      for (const item of node.children as Nodes[]) {
        const marker = node.ordered ? `${counter}. ` : "- ";
        counter += 1;
        const inner =
          item.type === "listItem"
            ? renderBlocks(item.children as Nodes[])
            : renderBlock(item);
        parts.push(prefixLines(inner, " ".repeat(marker.length), marker));
      }
      return joinRendered(parts, "\n");
    }
    case "table":
      return { text: tableToAscii(node as MdastTable), styles: [] };
    case "thematicBreak":
      return { text: "---", styles: [] };
    case "html":
      return { text: node.value, styles: [] };
    default: {
      const builder = new TextBuilder();
      if ("children" in node && Array.isArray(node.children)) {
        renderInline(node.children as Nodes[], builder, []);
      } else if ("value" in node && typeof node.value === "string") {
        builder.append(node.value, []);
      }
      return builder.finish();
    }
  }
}

function joinRendered(parts: RenderedText[], separator: string): RenderedText {
  const builder = new TextBuilder();
  let first = true;
  for (const part of parts) {
    if (!part.text) continue;
    if (!first) builder.append(separator, []);
    builder.appendRendered(part, []);
    first = false;
  }
  return builder.finish();
}

function renderBlocks(nodes: Nodes[]): RenderedText {
  return joinRendered(nodes.map(renderBlock), "\n\n");
}

/** Flatten an mdast tree into Relay text plus style runs. */
export function renderAst(ast: Root): RenderedText {
  return renderBlocks(ast.children as Nodes[]);
}

/** Flatten a Markdown string into Relay text plus style runs. */
export function renderMarkdown(markdown: string): RenderedText {
  return renderAst(parseMarkdown(markdown));
}

/**
 * Text a caller supplied verbatim. The empty `styles` array is meaningful to
 * Relay: it marks the part as structured plain text so no client tries to read
 * it as a legacy Markdown body.
 */
export function renderRawText(value: string): RenderedText {
  return { text: value, styles: [] };
}
