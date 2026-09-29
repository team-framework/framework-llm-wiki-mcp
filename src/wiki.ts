import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { hashContent, matchingPreview, parseFrontmatter, parseSections, queryTerms, sectionBlocks, termFrequency, type MarkdownSection } from "./sections.js";

const execFileAsync = promisify(execFile);
export const DEFAULT_CONTEXT_CHARS = 12_000;
const MAX_CONTEXT_CHARS = 128_000;
export type Note = { path: string; title: string; content: string; body: string; metadata: Record<string, unknown>; links: string[]; note_hash: string };
export type ResolvedLink = { link: string; status: "resolved" | "ambiguous" | "unresolved"; path?: string; candidates?: string[] };
export type ResolvedNote = Note & { resolved_links: ResolvedLink[] };
export type SearchOptions = { domain?: string; owner?: string; verification?: string; includeHistory?: boolean; limit?: number };
export type SectionRef = { path: string; section_id: string; hash?: string };
export type ReadOptions = { maxChars?: number; cursor?: string };
export type ContextOptions = SearchOptions & ReadOptions;
export type SemanticSearchProvider = (query: string, options: SearchOptions) => Promise<{ hits: Array<{ path: string; section_id: string; hash: string; score: number }>; status: string }>;
export type RetrievalStatus = { mode: "hybrid" | "lexical"; semantic_status: string; stale_hits: number };
export type Evidence = {
  path: string; title: string; metadata: Record<string, unknown>; verification: unknown;
  section_id: string; heading: string; headings: string[]; hash: string; content_hash: string; note_hash: string;
  source: { path: string; start_line: number; end_line: number };
  content: string; continued: boolean; complete: boolean;
};
type CacheEntry = { signature: string; note: Note; sections: MarkdownSection[] };
type RankedSection = { note: Note; section: MarkdownSection; score: number };
type Cursor = { v: 1; refs: SectionRef[]; index: number; offset: number };

function contained(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Validate both the requested path and its resolved target, including missing-file ancestors. */
export async function confinedNotePath(root: string, relativePath: string, allowMissing = false) {
  if (!relativePath || relativePath.includes("\0") || path.isAbsolute(relativePath) || /^[a-z]+:\/\//i.test(relativePath)) throw new Error("Invalid wiki note path.");
  const realRoot = await fs.realpath(root);
  const full = path.resolve(realRoot, relativePath.replace(/\\/g, "/"));
  if (!contained(realRoot, full) || path.extname(full).toLocaleLowerCase() !== ".md") throw new Error("Invalid wiki note path.");
  try {
    if (!contained(realRoot, await fs.realpath(full))) throw new Error("Invalid wiki note path.");
  } catch (error: unknown) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    let parent = path.dirname(full);
    while (true) {
      try { const actual = await fs.realpath(parent); if (actual !== realRoot && !contained(realRoot, actual)) throw new Error("Invalid wiki note path."); break; }
      catch (ancestorError: unknown) {
        if ((ancestorError as NodeJS.ErrnoException).code !== "ENOENT") throw ancestorError;
        const next = path.dirname(parent); if (next === parent) throw new Error("Invalid wiki note path."); parent = next;
      }
    }
  }
  return full;
}
function boundedInteger(value: number | undefined, fallback: number, maximum: number, name: string) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  return value;
}
function cursorEncode(cursor: Cursor) { return Buffer.from(JSON.stringify(cursor)).toString("base64url"); }
function cursorDecode(value: string): Cursor {
  if (value.length > 100_000) throw new Error("Invalid section cursor.");
  let cursor: Cursor;
  try { cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { throw new Error("Invalid section cursor."); }
  if (cursor.v !== 1 || !Array.isArray(cursor.refs) || !cursor.refs.length || cursor.refs.length > 64
    || !Number.isInteger(cursor.index) || cursor.index < 0 || cursor.index >= cursor.refs.length
    || !Number.isInteger(cursor.offset) || cursor.offset < 0
    || cursor.refs.some((ref) => typeof ref?.path !== "string" || typeof ref.section_id !== "string" || typeof ref.hash !== "string")) throw new Error("Invalid section cursor.");
  return cursor;
}

export class WikiService {
  private readonly cache = new Map<string, CacheEntry>();
  private indexSignature = "";
  private index: Array<{ note: Note; section: MarkdownSection }> = [];
  private semanticSearch?: SemanticSearchProvider;
  constructor(readonly root: string) {}
  setSemanticSearch(provider: SemanticSearchProvider) { this.semanticSearch = provider; }

  async listNotes(): Promise<Note[]> {
    const realRoot = await fs.realpath(this.root);
    const files = await this.markdownFiles(realRoot);
    const active = new Set(files);
    for (const cached of this.cache.keys()) if (!active.has(cached)) this.cache.delete(cached);
    // Check file stats every request; retain parsed content and the section index when unchanged.
    const notes = await Promise.all(files.map((file) => this.readFile(file, realRoot)));
    const signature = notes.map((note) => `${note.path}:${note.note_hash}`).sort().join("\n");
    if (signature !== this.indexSignature) {
      this.indexSignature = signature;
      this.index = files.flatMap((file) => { const item = this.cache.get(file)!; return item.sections.map((section) => ({ note: item.note, section })); });
    }
    return notes;
  }

  async search(query: string, options: SearchOptions = {}) {
    const limit = boundedInteger(options.limit, 10, 50, "limit");
    const { hits, retrieval } = await this.rankSections(query, options);
    const documents = new Map<string, RankedSection[]>();
    for (const hit of hits) { const group = documents.get(hit.note.path) ?? []; group.push(hit); documents.set(hit.note.path, group); }
    return [...documents.values()].slice(0, limit).map((group) => {
      const { note, section, score } = group[0];
      return { path: note.path, title: note.title, question: note.metadata.question ?? null,
        domain: note.metadata.domain ?? null, owner: note.metadata.owner ?? null,
        verification: note.metadata.verification ?? null, last_verified: note.metadata.last_verified ?? null,
        note_hash: note.note_hash, score: Math.round(score * 100_000) / 100_000, retrieval,
        excerpt: matchingPreview(section.content, query), sections: group.slice(0, 3).map(({ section: item }) => ({
          section_id: item.section_id, heading: item.heading, hash: item.hash, chars: item.content.length,
          start_line: item.start_line, end_line: item.end_line
        })) };
    });
  }

  async getNote(relativePath: string): Promise<ResolvedNote> {
    const full = await confinedNotePath(this.root, relativePath);
    const note = await this.readFile(full, await fs.realpath(this.root));
    const notes = await this.listNotes();
    return { ...note, resolved_links: this.resolveLinks(note.links, notes) };
  }
  async getOutline(relativePath: string) {
    const { note, sections } = await this.noteSections(relativePath);
    return { path: note.path, title: note.title, metadata: note.metadata, note_hash: note.note_hash,
      sections: sections.map(({ section_id, heading, headings, level, hash, content, start_line, end_line }) => ({
        section_id, heading, headings, level, hash, chars: content.length, start_line, end_line
      })) };
  }
  async getContext(query: string, options: ContextOptions = {}) {
    const limit = boundedInteger(options.limit, 8, 50, "limit");
    if (options.cursor) return { query, ...(await this.readSections([], options)) };
    const { hits, retrieval } = await this.rankSections(query, options);
    const refs = hits.slice(0, limit).map(({ note, section }) => ({ path: note.path, section_id: section.section_id, hash: section.hash }));
    return { query, retrieval, ...(await this.readSections(refs, options)) };
  }

  async readSections(refs: SectionRef[], options: ReadOptions = {}) {
    const maxChars = boundedInteger(options.maxChars, DEFAULT_CONTEXT_CHARS, MAX_CONTEXT_CHARS, "maxChars");
    if (!Array.isArray(refs) || refs.length > 64) throw new Error("At most 64 section references are allowed.");
    const state: Cursor = options.cursor ? cursorDecode(options.cursor) : { v: 1, refs: refs.map((ref) => ({ ...ref })), index: 0, offset: 0 };
    const selected = await Promise.all(state.refs.map(async (ref) => {
      const entry = await this.noteSections(ref.path);
      const section = entry.sections.find((section) => section.section_id === ref.section_id);
      if (!section) throw new Error(`Wiki section not found: ${ref.path}#${ref.section_id}`);
      if (ref.hash && section.hash !== ref.hash) throw new Error(`Stale section hash: ${ref.path}#${ref.section_id}`);
      ref.hash = section.hash;
      return { note: entry.note, section };
    }));
    const evidence: Evidence[] = [];
    let requiredChars: number | undefined;
    let truncated = false;
    for (; state.index < selected.length; state.index++, state.offset = 0) {
      const { note, section } = selected[state.index];
      const blocks = sectionBlocks(section.content);
      if (state.offset > 0 && !blocks.some((block) => block.start === state.offset)) throw new Error("Invalid section cursor boundary.");
      const initialOffset = state.offset;
      const sourceStart = section.start_line + section.content.slice(0, initialOffset).split(/\r?\n/).length - 1;
      const base: Evidence = { path: note.path, title: note.title, metadata: note.metadata, verification: note.metadata.verification ?? null,
        section_id: section.section_id, heading: section.heading, headings: section.headings, hash: section.hash, content_hash: section.hash,
        note_hash: note.note_hash, source: { path: note.path, start_line: sourceStart, end_line: section.end_line },
        content: "", continued: initialOffset > 0, complete: false };
      let item = base;
      for (const block of blocks.filter((block) => block.start >= initialOffset)) {
        const content = item.content + block.content;
        const candidate: Evidence = { ...base, content, complete: block.end === section.content.length,
          source: { ...base.source, end_line: Math.max(sourceStart, sourceStart + content.split(/\r?\n/).length - (content.endsWith("\n") ? 2 : 1)) } };
        if (JSON.stringify([...evidence, candidate]).length > maxChars) {
          requiredChars = JSON.stringify([{ ...base, content: block.content }]).length;
          truncated = true; break;
        }
        item = candidate; state.offset = block.end;
      }
      if (item.content) evidence.push(item);
      if (truncated) break;
    }
    return { evidence, evidence_chars: JSON.stringify(evidence).length, budget_chars: maxChars,
      truncated, next_cursor: truncated ? cursorEncode(state) : null,
      ...(requiredChars ? { required_chars: requiredChars, continuation: "Pass next_cursor to read_sections; increase max_chars if one Markdown block exceeds the budget." } : {}) };
  }

  async status() {
    let commit: string | null = null;
    try { const result = await execFileAsync("git", ["-C", this.root, "rev-parse", "HEAD"]); commit = result.stdout.trim(); } catch { /* Local development can use a directory without Git metadata. */ }
    return { wiki_root: this.root, wiki_commit: commit, note_count: (await this.listNotes()).length };
  }
  private async noteSections(relativePath: string) {
    const full = await confinedNotePath(this.root, relativePath);
    await this.readFile(full, await fs.realpath(this.root));
    return this.cache.get(full)!;
  }
  private async markdownFiles(directory: string): Promise<string[]> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return [".git", ".obsidian", "node_modules"].includes(entry.name) ? [] : this.markdownFiles(full);
      return entry.isFile() && entry.name.toLocaleLowerCase().endsWith(".md") ? [full] : [];
    }));
    return nested.flat().sort();
  }
  private async readFile(full: string, realRoot: string): Promise<Note> {
    if (!contained(realRoot, await fs.realpath(full))) throw new Error("Invalid wiki note path.");
    const stat = await fs.stat(full, { bigint: true });
    if (!stat.isFile()) throw new Error("Invalid wiki note path.");
    const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const cached = this.cache.get(full);
    if (cached?.signature === signature) return cached.note;
    const content = await fs.readFile(full, "utf8");
    if (!contained(realRoot, await fs.realpath(full))) throw new Error("Invalid wiki note path.");
    const after = await fs.stat(full, { bigint: true });
    if (after.ino !== stat.ino || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) return this.readFile(full, realRoot);
    const { metadata, body } = parseFrontmatter(content);
    const sections = parseSections(content);
    const title = sections.find((section) => section.level === 1)?.heading ?? path.basename(full, ".md");
    const note = { path: path.relative(realRoot, full).split(path.sep).join("/"), title, content, body, metadata,
      links: [...body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((match) => match[1].trim()), note_hash: hashContent(content) };
    this.cache.set(full, { signature, note, sections });
    return note;
  }

  private async rankSections(query: string, options: SearchOptions): Promise<{ hits: RankedSection[]; retrieval: RetrievalStatus }> {
    const retrieval: RetrievalStatus = { mode: "lexical", semantic_status: this.semanticSearch ? "unavailable" : "not_configured", stale_hits: 0 };
    const terms = queryTerms(query);
    if (!terms.length) return { hits: [], retrieval };
    await this.listNotes();
    const candidates = this.index.filter(({ note }) => (options.includeHistory || !note.path.split("/").includes("사건기록")) && this.matches(note, options));
    const frequencies = candidates.map(({ section }) => terms.map((term) => termFrequency(section.content, term)));
    const df = terms.map((_term, index) => frequencies.filter((freq) => freq[index] > 0).length);
    const averageLength = candidates.reduce((sum, { section }) => sum + section.content.length, 0) / (candidates.length || 1);
    const lexical = candidates.map(({ note, section }, candidateIndex) => {
      let score = 0;
      for (let index = 0; index < terms.length; index++) {
        const term = terms[index]; const tf = frequencies[candidateIndex][index];
        const idf = Math.log(1 + (candidates.length - df[index] + 0.5) / (df[index] + 0.5));
        score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * section.content.length / (averageLength || 1)));
        score += (termFrequency(section.heading, term) ? 8 : 0) + (termFrequency(section.headings.join(" "), term) ? 3 : 0)
          + (termFrequency(note.title, term) ? 3 : 0) + (termFrequency(String(note.metadata.question ?? ""), term) ? 4 : 0)
          + (termFrequency(note.path, term) ? 2 : 0);
      }
      return { note, section, score };
    }).filter(({ score }) => score > 0).sort(rankOrder);
    if (!this.semanticSearch) return { hits: lexical, retrieval };
    try {
      const semantic = await this.semanticSearch(query, options);
      retrieval.semantic_status = semantic.status;
      const valid = new Map(candidates.map((entry) => [`${entry.note.path}\0${entry.section.section_id}`, entry]));
      const fusion = new Map<string, RankedSection>();
      lexical.forEach((hit, index) => fusion.set(`${hit.note.path}\0${hit.section.section_id}`, { ...hit, score: 1 / (60 + index + 1) }));
      let accepted = 0;
      const seen = new Set<string>();
      semantic.hits.slice(0, 100).forEach((hit, index) => {
        const key = `${hit.path}\0${hit.section_id}`;
        if (seen.has(key)) return;
        seen.add(key);
        const current = valid.get(key);
        if (!current || current.section.hash !== hit.hash) { retrieval.stale_hits++; return; }
        accepted++;
        const existing = fusion.get(key);
        fusion.set(key, { ...current, score: (existing?.score ?? 0) + 1 / (60 + index + 1) });
      });
      if (accepted) retrieval.mode = "hybrid";
      return { hits: accepted ? [...fusion.values()].sort(rankOrder) : lexical, retrieval };
    } catch { return { hits: lexical, retrieval }; }
  }
  private matches(note: Note, options: SearchOptions) {
    return (!options.domain || includesMetadataValue(note.metadata.domain, options.domain))
      && (!options.owner || includesMetadataValue(note.metadata.owner, options.owner))
      && (!options.verification || note.metadata.verification === options.verification);
  }
  private resolveLinks(links: string[], notes: Note[]): ResolvedLink[] {
    return links.map((link) => {
      const target = normalizeNoteReference(link.split("#", 1)[0].trim());
      const candidates = notes.filter((note) => [note.path, path.basename(note.path, ".md"), note.title].some((value) => normalizeNoteReference(value) === target)).map((note) => note.path).sort((a, b) => a.localeCompare(b, "ko"));
      if (candidates.length === 1) return { link, status: "resolved", path: candidates[0] };
      if (candidates.length > 1) return { link, status: "ambiguous", candidates };
      return { link, status: "unresolved" };
    });
  }
}
function rankOrder(a: RankedSection, b: RankedSection) { return b.score - a.score || a.note.path.localeCompare(b.note.path, "ko") || a.section.start - b.section.start; }
function normalizeNoteReference(value: string) { return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.md$/i, "").trim().toLocaleLowerCase(); }
function includesMetadataValue(value: unknown, expected: string) { return Array.isArray(value) ? value.includes(expected) : value === expected; }
