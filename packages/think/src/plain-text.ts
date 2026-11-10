// Relay renders inline Markdown (bold, italic, strikethrough, inline code,
// links) and nothing else, so block Markdown from a model shows as raw "#",
// "-" and "|" marks. The mdast parser finds the blocks; the words of each
// leaf block are kept as the model wrote them, and blocks are separated by
// the line breaks that separated them in the source.
import type { Nodes, PhrasingContent, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

type Line = { text: string; start: number; end: number };

function source(text: string, node: Nodes): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? "" : text.slice(start, end);
}

// A text node spanning lines inside a quote or list carries the container's
// markers in its source, so its parsed value stands in for it; every other
// inline node is copied exactly as written.
function inline(text: string, children: PhrasingContent[]): string {
  return children.map((child) => {
    if (child.type === "break") return "\n";
    const written = source(text, child);
    return child.type === "text" && written.includes("\n") ? child.value : written;
  }).join("");
}

function line(node: Nodes, value: string): Line[] {
  const start = node.position?.start.offset ?? 0;
  const end = node.position?.end.offset ?? start;
  return value.trim() ? [{ text: value.trim(), start, end }] : [];
}

function lines(text: string, node: RootContent): Line[] {
  switch (node.type) {
    case "paragraph":
    case "heading":
      return line(node, inline(text, node.children));
    case "code":
      return line(node, node.value);
    case "html":
      return line(node, source(text, node));
    case "thematicBreak":
    case "definition":
      return [];
    case "table":
      return node.children.flatMap((row) =>
        line(row, row.children.map((cell) => inline(text, cell.children).trim()).filter(Boolean).join(", ")));
    case "blockquote":
    case "list":
    case "listItem":
    case "footnoteDefinition":
      return node.children.flatMap((child) => lines(text, child));
    default:
      return line(node, source(text, node));
  }
}

/** Block Markdown in a chat Message becomes plain lines; inline Markdown stays. */
export function plainChatText(text: string): string {
  const root = fromMarkdown(text, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  if (root.children.every((node) => node.type === "paragraph")) return text;
  const kept = root.children.flatMap((node) => lines(text, node));
  return kept.map((entry, index) => {
    if (index === 0) return entry.text;
    const gap = text.slice(kept[index - 1]!.end, entry.start);
    // A blank line (bare, or holding only quote marks) stays one blank line.
    return (/\n[ \t>]*\n/.test(gap) ? "\n\n" : "\n") + entry.text;
  }).join("");
}
