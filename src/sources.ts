import { NotionError, NotionService, notionLinks, type NotionPage } from "./notion.js";
import { hashContent, parseSections, queryTerms, sectionBlocks } from "./sections.js";
import type { ContextOptions, Note, SemanticSearchProvider, WikiService } from "./wiki.js";
import type { Evidence, WikiContext } from "./chat.js";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type SourceMode = "wiki" | "notion" | "all";
export class NotionIndex {
  private pages = new Map<string, NotionPage>();
  private syncing: Promise<void> | null = null;
  private state = "starting";
  private updatedAt: string | null = null;
  private truncated = false;
  private progress = { discovered: 0, fetched: 0, reused: 0, failed: 0, removed: 0, partial_content: 0 };
  private error: string | null = null;
  private restored = false;
  private semantic?: SemanticSearchProvider;
  constructor(readonly notion: NotionService, readonly cachePath?: string) {}
  setSemanticSearch(provider: SemanticSearchProvider) { this.semantic = provider; }
  status() { return { state: this.notion.enabled ? this.state : "disabled", pages: this.pages.size, updated_at: this.updatedAt, truncated: this.truncated, ...this.progress, error: this.error }; }
  private identity() { return createHash("sha256").update(JSON.stringify([...this.notion.roots].sort()) + "\0" + this.notion.options.token).digest("hex"); }
  private async restore() {
    if (this.restored) return; this.restored = true;
    if (!this.cachePath) return;
    try {
      const saved = JSON.parse(await fs.readFile(this.cachePath, "utf8"));
      if (saved.version !== 1 || saved.identity !== this.identity() || !Array.isArray(saved.pages)) return;
      for (const page of saved.pages) {
        if (typeof page.id === "string" && /^[a-f0-9]{32}$/.test(page.id) && typeof page.content === "string" && typeof page.title === "string" && typeof page.last_edited_time === "string" && typeof page.retrieved_at === "string" && typeof page.truncated === "boolean" && page.content_hash === hashContent(page.content) && Array.isArray(page.unknown_block_ids)) this.pages.set(page.id, page);
      }
      this.updatedAt = saved.updated_at ?? null;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.error = "notion_cache_unavailable"; }
  }
  private async save() {
    if (!this.cachePath) return;
    await fs.mkdir(path.dirname(this.cachePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.cachePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, identity: this.identity(), updated_at: this.updatedAt, pages: [...this.pages.values()] }), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, this.cachePath);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async listNotes(): Promise<Note[]> {
    return [...this.pages.values()].map((page) => ({ path: `notion/${page.id}`, title: page.title, content: page.content, body: page.content, metadata: { source_type: "notion", verification: "unverified" }, links: [], note_hash: page.content_hash }));
  }
  sync(): Promise<void> {
    if (!this.notion.enabled) return Promise.resolve();
    if (this.syncing) return this.syncing;
    this.syncing = this.refresh().catch((error) => {
      this.state = "unavailable"; this.truncated = true;
      this.error = error instanceof NotionError ? error.code : "notion_index_unavailable";
    }).finally(() => { this.syncing = null; });
    return this.syncing;
  }
  private async refresh() {
    await this.restore(); this.state = "indexing"; this.error = null; this.truncated = true;
    this.progress = { discovered: 0, fetched: 0, reused: 0, failed: 0, removed: 0, partial_content: 0 };
    const next = new Map<string, NotionPage>();
    const initialIds = new Set(this.pages.keys());
    for await (const item of this.notion.scanPages(() => { this.progress.failed++; })) {
      this.progress.discovered++;
      try {
        const previous = this.pages.get(item.id); const page = await item.load(previous);
        next.set(item.id, page); this.pages.set(item.id, page);
        if (previous && !previous.truncated && previous.last_edited_time === page.last_edited_time) this.progress.reused++;
        else this.progress.fetched++;
        if (page.truncated) this.progress.partial_content++;
      } catch (error) {
        this.progress.failed++; this.pages.delete(item.id);
        if (error instanceof NotionError && ["notion_auth_failed", "notion_closed"].includes(error.code)) throw error;
      }
      // A private checkpoint avoids fetching completed bodies again after restart.
      if (this.progress.discovered % 25 === 0) await this.save();
    }
    this.progress.removed = [...initialIds].filter((id) => !next.has(id)).length;
    this.pages = next; this.truncated = this.progress.failed > 0 || this.progress.partial_content > 0;
    this.updatedAt = new Date().toISOString(); await this.save(); this.state = "ready";
  }
  async candidates(query: string, limit = 5) {
    const terms = queryTerms(query); const scores = new Map<string, number>();
    for (const page of this.pages.values()) {
      const title = page.title.normalize("NFKC").toLowerCase(); const body = page.content.normalize("NFKC").toLowerCase();
      const score = terms.reduce((sum, term) => sum + (title.includes(term) ? 3 : 0) + (body.includes(term) ? 1 : 0), 0);
      if (score) scores.set(page.id, score);
    }
    let semanticStatus = "disabled";
    if (this.semantic && this.state === "ready") {
      const result = await this.semantic(query, { limit }); semanticStatus = result.status;
      for (const hit of result.hits) {
        if (hit.score < 0.7 || !hit.path.startsWith("notion/")) continue;
        const id = hit.path.slice(7); const page = this.pages.get(id);
        if (page && parseSections(page.content).some((section) => section.section_id === hit.section_id && section.hash === hit.hash)) scores.set(id, (scores.get(id) ?? 0) + hit.score);
      }
    }
    return { ids: [...scores].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id), semantic_status: semanticStatus };
  }
  remove(id: string) { this.pages.delete(id); }
}

/** Wiki and Notion share evidence budgeting, while their original documents remain separate. */
export class SourceContext {
  constructor(readonly wiki: WikiService, readonly notion: NotionService, readonly index: NotionIndex) {}
  async getContext(query: string, options: ContextOptions & { sources?: SourceMode } = {}): Promise<WikiContext> {
    const maxChars = options.maxChars ?? 12_000; const mode = options.sources ?? "all";
    if (mode === "wiki") return this.wiki.getContext(query, options);
    if (!this.notion.enabled && mode === "all") {
      const wiki = await this.wiki.getContext(query, { ...options, maxChars: Math.max(1, maxChars - 250) });
      return { ...wiki, notices: [{ source: "notion", code: "notion_unconfigured" }], source_status: { wiki: "ready", notion: "disabled" } };
    }
    const explicit = notionLinks(query);
    const notices: Array<{ source: string; code: string }> = [];
    let candidates = [...explicit]; let searchTruncated = false; let semanticStatus = "disabled";
    // Wiki metadata filters do not silently broaden to unclassified external pages.
    const includeNotion = mode === "notion" || !options.domain && !options.owner && !options.verification;
    if (includeNotion) {
      try {
        if (!this.notion.enabled) throw new NotionError(503, "notion_unconfigured");
        if (!candidates.length) {
          const ranked = await this.index.candidates(query, Math.min(options.limit ?? 5, 5));
          candidates = ranked.ids; semanticStatus = ranked.semantic_status;
          if (!candidates.length) {
            const found = await this.notion.search(query, Math.min(options.limit ?? 5, 5));
            candidates = found.results.map((page) => page.id); searchTruncated = found.truncated;
          }
          if (this.index.status().state !== "ready") notices.push({ source: "notion", code: "notion_title_search_only" });
          if (this.index.status().truncated) notices.push({ source: "notion", code: "notion_index_partial" });
        }
      } catch (error) { notices.push({ source: "notion", code: error instanceof NotionError ? error.code : "notion_unavailable" }); }
    } else candidates = [];
    const external: Evidence[] = [];
    const terms = queryTerms(query);
    for (const id of candidates) {
      try {
        // Re-fetch permissions and edit metadata before using an indexed or cached document.
        const page = await this.notion.read(id);
        const sections = parseSections(page.content).sort((a, b) => {
          const score = (content: string) => terms.filter((term) => content.normalize("NFKC").toLowerCase().includes(term)).length;
          return explicit.includes(id) ? a.start - b.start : score(b.content) - score(a.content);
        });
        for (const section of sections.slice(0, explicit.includes(id) ? 8 : 2)) external.push({ path: `notion/${page.id}`, title: page.title, url: page.url, source_type: "notion", heading: section.heading,
          section_id: section.section_id, content: section.content, content_hash: section.hash, verification: "unverified",
          metadata: { source_type: "notion", source_url: page.url, page_last_edited_at: page.last_edited_time, retrieved_at: page.retrieved_at, note_hash: page.content_hash, truncated: page.truncated, unknown_block_ids: page.unknown_block_ids } });
        if (page.truncated) notices.push({ source: "notion", code: "notion_partial_content" });
      } catch (error) { this.index.remove(id); notices.push({ source: "notion", code: error instanceof NotionError ? error.code : "notion_unavailable" }); }
    }
    const wiki = mode === "notion" ? { evidence: [], truncated: false } : await this.wiki.getContext(query, { ...options, maxChars });
    // Alternate sources so long wiki sections cannot consume the whole budget first.
    const pending: Evidence[] = [];
    for (let i = 0; i < Math.max(wiki.evidence.length, external.length); i++) {
      if (external[i]) pending.push(external[i]); if (wiki.evidence[i]) pending.push(wiki.evidence[i]);
    }
    const result: WikiContext = { query, evidence: [], truncated: Boolean(wiki.truncated || searchTruncated || notices.length),
      source_status: { wiki: mode === "notion" ? "excluded" : "ready", notion: includeNotion ? this.notion.enabled ? "enabled" : "disabled" : "excluded", index: this.index.status(), semantic_status: semanticStatus }, notices,
      budget_chars: maxChars, required_chars: null };
    for (const item of pending) {
      const blocks = sectionBlocks(item.content); let content = "";
      for (const block of blocks) {
        const next = { ...item, content: content + block.content };
        if (JSON.stringify({ ...result, evidence: [...result.evidence, next] }).length > maxChars) { result.truncated = true; result.required_chars = Math.max(Number(result.required_chars ?? 0), JSON.stringify({ ...result, evidence: [ { ...item, content: block.content } ] }).length); break; }
        content += block.content;
      }
      if (content) result.evidence.push({ ...item, content, ...(content.length < item.content.length ? { metadata: { ...item.metadata, excerpt_truncated: true } } : {}) });
      else if (item.content) result.truncated = true;
    }
    // Large status/notice metadata can consume a very small caller budget.
    while (JSON.stringify(result).length > maxChars && result.evidence.length) { result.evidence.pop(); result.truncated = true; }
    return result;
  }
}
