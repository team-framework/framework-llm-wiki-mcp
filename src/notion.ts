import { hashContent, sectionBlocks } from "./sections.js";

export const NOTION_VERSION = "2026-03-11";
const UUID = /^[a-f0-9]{32}$/i;
export function notionId(value: string): string {
  let candidate = value.trim();
  if (/^https?:/i.test(candidate)) {
    let url: URL;
    try { url = new URL(candidate); } catch { throw new NotionError(400, "invalid_notion_id"); }
    if (url.protocol !== "https:" || url.username || url.password || !["notion.so", "www.notion.so", "app.notion.com", "www.notion.com", "notion.com"].includes(url.hostname) && !url.hostname.endsWith(".notion.site")) throw new NotionError(400, "invalid_notion_id");
    try { candidate = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? ""); } catch { throw new NotionError(400, "invalid_notion_id"); }
    candidate = candidate.match(/([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i)?.[1] ?? "";
  }
  candidate = candidate.replaceAll("-", "").toLowerCase();
  if (!UUID.test(candidate)) throw new NotionError(400, "invalid_notion_id");
  return candidate;
}
export function notionLinks(text: string): string[] {
  const ids = new Set<string>();
  for (const link of text.match(/https:\/\/[^\s<>"')\]]+/g) ?? []) {
    try { ids.add(notionId(link.replace(/[.,;]+$/, ""))); } catch { /* Other links are not Notion sources. */ }
  }
  return [...ids].slice(0, 5);
}
export class NotionError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export type NotionPage = { id: string; title: string; url: string; last_edited_time: string; retrieved_at: string; content: string; content_hash: string; truncated: boolean; unknown_block_ids: string[] };
export type NotionOptions = { token?: string; rootIds?: string[]; fetchImpl?: typeof fetch; now?: () => number; pause?: (ms: number) => Promise<void>; cacheMs?: number; intervalMs?: number };
type Entity = { id: string; object?: string; parent?: Record<string, unknown>; properties?: Record<string, any>; archived?: boolean; in_trash?: boolean; last_edited_time?: string; data_sources?: Array<{ id: string }> };

/** The token stays here. Every read rechecks the page and its ancestry, including cache hits. */
export class NotionService {
  readonly roots: Set<string>;
  private cache = new Map<string, { page: NotionPage; at: number }>();
  private queue: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;
  private abort = new AbortController();
  constructor(readonly options: NotionOptions = {}) { this.roots = new Set((options.rootIds ?? []).map(notionId)); }
  get enabled() { return Boolean(this.options.token?.trim() && this.roots.size); }
  status() { return { enabled: this.enabled, roots: [...this.roots], api_version: NOTION_VERSION }; }
  close() { this.abort.abort(); this.cache.clear(); }
  private now() { return (this.options.now ?? Date.now)(); }
  private pause(ms: number) { return (this.options.pause ?? ((delay) => new Promise<void>((resolve) => setTimeout(resolve, delay))))(ms); }

  private async request(endpoint: string, body?: unknown): Promise<any> {
    if (!this.enabled) throw new NotionError(503, "notion_unconfigured");
    if (this.abort.signal.aborted) throw new NotionError(503, "notion_closed");
    // Share a start-time limiter across searches, reads, retries, and index refreshes.
    for (let attempt = 0; attempt < 3; attempt++) {
      const slot = this.queue.then(async () => {
        await this.pause(Math.max(0, this.nextRequestAt - this.now()));
        if (this.abort.signal.aborted) throw new NotionError(503, "notion_closed");
        this.nextRequestAt = this.now() + (this.options.intervalMs ?? 350);
      });
      this.queue = slot.catch(() => {}); await slot;
      let response: Response;
      try {
        response = await (this.options.fetchImpl ?? fetch)(new URL(endpoint, "https://api.notion.com"), {
          method: body === undefined ? "GET" : "POST", redirect: "error",
          headers: { Authorization: `Bearer ${this.options.token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)])
        });
      } catch { throw new NotionError(502, "notion_unavailable"); }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retry = Number(response.headers.get("retry-after"));
        await response.body?.cancel();
        await this.pause(Math.min(5_000, Math.max(350, Number.isFinite(retry) ? retry * 1000 : 350 * (attempt + 1))));
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new NotionError(response.status === 404 || response.status === 403 ? 404 : response.status === 401 ? 503 : response.status === 429 ? 429 : 502,
          response.status === 404 || response.status === 403 ? "notion_not_accessible" : response.status === 401 ? "notion_auth_failed" : response.status === 429 ? "notion_rate_limited" : "notion_unavailable");
      }
      try {
        const reader = response.body?.getReader(); if (!reader) throw new Error();
        const chunks: Uint8Array[] = []; let size = 0;
        while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 4_000_000) { await reader.cancel(); throw new Error(); } chunks.push(value); }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch { throw new NotionError(502, "notion_invalid_response"); }
    }
    throw new NotionError(502, "notion_unavailable");
  }
  private active(entity: Entity) { if (!entity.id || entity.archived || entity.in_trash) throw new NotionError(404, "notion_not_accessible"); }
  private async scoped(page: Entity): Promise<void> {
    this.active(page); let current = page; const seen = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      const id = notionId(current.id); if (seen.has(id)) break; seen.add(id);
      if (this.roots.has(id)) return;
      const parent = current.parent; if (!parent) break;
      const type = String(parent.type ?? ""); const parentId = parent[type];
      if (typeof parentId !== "string") break;
      const paths: Record<string, string> = { page_id: "pages", database_id: "databases", data_source_id: "data_sources", block_id: "blocks" };
      if (!paths[type]) break;
      current = await this.request(`/v1/${paths[type]}/${notionId(parentId)}`); this.active(current);
    }
    throw new NotionError(404, "notion_outside_roots");
  }
  private title(page: Entity) {
    const title = Object.values(page.properties ?? {}).find((property: any) => property.type === "title")?.title;
    return Array.isArray(title) ? title.map((part: any) => part.plain_text ?? part.text?.content ?? "").join("") || "제목 없음" : "제목 없음";
  }
  async metadata(value: string) {
    const id = notionId(value);
    try { const page: Entity = await this.request(`/v1/pages/${id}`); await this.scoped(page); return page; }
    catch (error) { this.cache.delete(id); throw error; }
  }
  async search(query: string, limit = 10, maxPages = 20) {
    const results: Array<{ id: string; title: string; url: string; last_edited_time: string }> = [];
    let cursor: string | undefined; let hasMore = false;
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
      const page = await this.request("/v1/search", { ...(query.trim() ? { query: query.trim() } : {}), filter: { property: "object", value: "page" }, sort: { direction: "descending", timestamp: "last_edited_time" }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
      if (!Array.isArray(page.results)) throw new NotionError(502, "notion_invalid_response");
      hasMore = Boolean(page.has_more); cursor = typeof page.next_cursor === "string" ? page.next_cursor : undefined;
      for (const entity of page.results as Entity[]) {
        try { await this.scoped(entity); }
        catch (error) { if (error instanceof NotionError && error.status === 404) continue; throw error; }
        const id = notionId(entity.id);
        results.push({ id, title: this.title(entity), url: `https://app.notion.com/p/${id}`, last_edited_time: entity.last_edited_time ?? "" });
        if (results.length >= limit) return { results, truncated: hasMore || page.results.indexOf(entity) < page.results.length - 1 };
      }
      if (!hasMore || !cursor) break;
    }
    return { results, truncated: hasMore };
  }
  async read(value: string): Promise<NotionPage> {
    const id = notionId(value); const metadata = await this.metadata(id);
    const cached = this.cache.get(id);
    if (cached && cached.page.last_edited_time === metadata.last_edited_time && this.now() - cached.at < (this.options.cacheMs ?? 60_000)) return cached.page;
    try {
      const result = await this.request(`/v1/pages/${id}/markdown`);
      if (typeof result.markdown !== "string" || !Array.isArray(result.unknown_block_ids)) throw new NotionError(502, "notion_invalid_response");
      // Keep unloaded subtrees distinct: appending them at the end would change document order.
      const page: NotionPage = { id, title: this.title(metadata), url: `https://app.notion.com/p/${id}`, last_edited_time: metadata.last_edited_time ?? "", retrieved_at: new Date(this.now()).toISOString(), content: result.markdown,
        content_hash: hashContent(result.markdown), truncated: Boolean(result.truncated) || /<unknown\b/.test(result.markdown), unknown_block_ids: result.unknown_block_ids.filter((v: unknown) => typeof v === "string") };
      if (this.cache.size >= 250) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(id, { page, at: this.now() }); return page;
    } catch (error) { this.cache.delete(id); throw error; }
  }
  async readBounded(value: string, maxChars = 20_000, startBlock = 0, subtreeId?: string, expectedHash?: string) {
    const page = { ...await this.read(value) };
    if (subtreeId) {
      const id = notionId(subtreeId);
      if (!page.unknown_block_ids.some((unknown) => notionId(unknown) === id)) throw new NotionError(400, "invalid_notion_subtree");
      try { await this.metadata(id); }
      catch (error) {
        if (!(error instanceof NotionError && error.code === "notion_not_accessible")) throw error;
        const block = await this.request(`/v1/blocks/${id}`); await this.scoped(block);
      }
      const subtree = await this.request(`/v1/pages/${id}/markdown`);
      if (typeof subtree.markdown !== "string" || !Array.isArray(subtree.unknown_block_ids)) throw new NotionError(502, "notion_invalid_response");
      page.content = subtree.markdown; page.content_hash = hashContent(subtree.markdown); page.truncated = Boolean(subtree.truncated) || /<unknown\b/.test(subtree.markdown); page.unknown_block_ids = subtree.unknown_block_ids;
    }
    if (startBlock > 0 && !expectedHash) throw new NotionError(400, "notion_hash_required");
    if (expectedHash && expectedHash !== page.content_hash) throw new NotionError(409, "notion_stale_cursor");
    const { content, ...metadata } = page; const blocks = sectionBlocks(content);
    const result = { ...metadata, ...(subtreeId ? { subtree_id: notionId(subtreeId) } : {}), content: "", content_truncated: false, next_block: null as number | null, required_chars: null as number | null };
    if (startBlock > blocks.length) throw new NotionError(400, "invalid_notion_cursor");
    for (let index = startBlock; index < blocks.length; index++) {
      const next = { ...result, content: result.content + blocks[index].content };
      if (JSON.stringify(next).length + 100 > maxChars) { result.content_truncated = true; result.next_block = index; result.required_chars = JSON.stringify({ ...result, content: blocks[index].content }).length + 100; break; }
      result.content = next.content;
    }
    if (JSON.stringify(result).length > maxChars) throw new NotionError(413, "notion_metadata_exceeds_budget");
    return result;
  }
}
