import { createHash } from "node:crypto";
import YAML from "yaml";

export const hashContent = (content: string) => createHash("sha256").update(content).digest("hex");

export type MarkdownSection = {
  section_id: string;
  heading: string;
  headings: string[];
  level: number;
  content: string;
  hash: string;
  start: number;
  end: number;
  start_line: number;
  end_line: number;
};

export function parseFrontmatter(content: string) {
  const match = content.match(/^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { metadata: {} as Record<string, unknown>, body: content, offset: 0 };
  const parsed: unknown = YAML.parse(match[1]);
  const metadata = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  return { metadata, body: content.slice(match[0].length), offset: match[0].length };
}

type Line = { text: string; start: number; end: number; number: number };
function linesOf(content: string): Line[] {
  const lines: Line[] = [];
  const pattern = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) && match[0].length) {
    lines.push({ text: match[0].replace(/[\r\n]+$/, ""), start: match.index, end: pattern.lastIndex, number: lines.length + 1 });
  }
  return lines;
}

function fenceMarker(line: string) {
  return line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
}
function headingText(value: string) { return value.replace(/\s+#+\s*$/, "").trim(); }
function slug(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || "section";
}

/** Every heading starts a section. Fence contents and YAML never become headings. */
export function parseSections(content: string): MarkdownSection[] {
  const { offset } = parseFrontmatter(content);
  const lines = linesOf(content);
  const starts: Array<{ start: number; line: number; heading: string; level: number; headings: string[] }> = [];
  const ancestors: Array<{ level: number; heading: string }> = [];
  let fence: { marker: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.start < offset) continue;
    const marker = fenceMarker(line.text);
    if (fence) {
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) { fence = { marker: marker[1][0], length: marker[1].length }; continue; }
    const atx = line.text.match(/^ {0,3}(#{1,6})\s+(.+?)\s*$/);
    const next = lines[index + 1];
    const setext = !atx && line.text.trim() ? next?.text.match(/^ {0,3}(=+|-+)\s*$/) : null;
    // Indented code, table rows, list entries, and blockquotes are not setext headings.
    const validSetext = setext && !/^(?: {4}|\t|\s*[>|*+-]\s|\s*\|)/.test(line.text);
    if (!atx && !validSetext) continue;
    const level = atx ? atx[1].length : setext![1][0] === "=" ? 1 : 2;
    const heading = headingText(atx ? atx[2] : line.text);
    while (ancestors.length && ancestors.at(-1)!.level >= level) ancestors.pop();
    ancestors.push({ level, heading });
    starts.push({ start: line.start, line: line.number, heading, level, headings: ancestors.map((entry) => entry.heading) });
    if (validSetext) index++;
  }
  if (!starts.length || starts[0].start > offset) {
    starts.unshift({ start: offset, line: content.slice(0, offset).split(/\r?\n/).length, heading: "", level: 0, headings: [] });
  }
  const occurrences = new Map<string, number>();
  return starts.map((entry, index) => {
    const end = starts[index + 1]?.start ?? content.length;
    const text = content.slice(entry.start, end);
    const base = entry.heading ? slug(entry.headings.join("/")) : "preamble";
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return { section_id: `${base}:${occurrence}`, heading: entry.heading, headings: entry.headings,
      level: entry.level, content: text, hash: hashContent(text), start: entry.start, end,
      start_line: entry.line, end_line: Math.max(entry.line, entry.line + text.split(/\r?\n/).length - (text.endsWith("\n") ? 2 : 1)) };
  }).filter((section) => section.content.length > 0);
}

export type MarkdownBlock = { start: number; end: number; content: string };

/** Continuations split at blank lines, never inside a fenced block or adjacent table rows. */
export function sectionBlocks(content: string): MarkdownBlock[] {
  const lines = linesOf(content);
  const blocks: MarkdownBlock[] = [];
  let start = 0;
  let fence: { marker: string; length: number } | null = null;
  for (const line of lines) {
    const marker = fenceMarker(line.text);
    if (fence) {
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) { fence = { marker: marker[1][0], length: marker[1].length }; continue; }
    if (!line.text.trim()) {
      const text = content.slice(start, line.end);
      if (text.trim()) { blocks.push({ start, end: line.end, content: text }); start = line.end; }
    }
  }
  if (start < content.length) blocks.push({ start, end: content.length, content: content.slice(start) });
  return blocks;
}

export function queryTerms(query: string) {
  return [...new Set(query.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}_]+(?:[./:-][\p{L}\p{N}_]+)*/gu) ?? [])].slice(0, 32);
}

export function termFrequency(text: string, term: string) {
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  if (/\p{Script=Hangul}/u.test(term)) {
    let count = 0; let position = 0;
    while ((position = normalized.indexOf(term, position)) >= 0 && count < 32) { count++; position += term.length; }
    return count;
  }
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Math.min(32, [...normalized.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "gu"))].length);
}

export function matchingPreview(content: string, query: string, maxChars = 220) {
  const normalized = content.normalize("NFKC").toLocaleLowerCase();
  const terms = queryTerms(query);
  const index = terms.reduce((best, term) => { const found = normalized.indexOf(term); return found < 0 ? best : Math.min(best, found); }, Infinity);
  const start = Number.isFinite(index) ? Math.max(0, index - 45) : 0;
  const preview = content.slice(start, start + maxChars).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${preview}${start + maxChars < content.length ? "…" : ""}`;
}
