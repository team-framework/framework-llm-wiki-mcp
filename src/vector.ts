import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { hashContent, parseSections } from "./sections.js";
import type { WikiService, SearchOptions } from "./wiki.js";

const MODEL = "intfloat/multilingual-e5-small";
const REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3";
const SCHEMA = "e5-small-480-overlap48-v1";
const MANIFEST_ID = "00000000-0000-4000-8000-000000000001";
type VectorPart = { index: number; part: number; start: number; end: number; vector: number[] };
type Embeddings = { model: string; revision: string; schema: string; vectors: VectorPart[] };
type IndexSection = { path: string; section_id: string; hash: string; input: string; domain: unknown; owner: unknown; verification: unknown; history: boolean };
export type VectorOptions = { qdrantUrl: string; embeddingUrl: string; cacheDir: string; alias?: string; fetchImpl?: typeof fetch };

export function vectorPointId(value: string) {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function validEmbeddings(result: Embeddings, texts: string[], mode: "query" | "passage") {
  if (result.model !== MODEL || result.revision !== REVISION || result.schema !== SCHEMA || !Array.isArray(result.vectors) || !result.vectors.length) return false;
  if (result.vectors.some((part) => !Number.isInteger(part.index) || part.index < 0 || part.index >= texts.length ||
    !Number.isInteger(part.part) || !Number.isInteger(part.start) || !Number.isInteger(part.end) ||
    !Array.isArray(part.vector) || part.vector.length !== 384 || part.vector.some((v) => !Number.isFinite(v)))) return false;
  for (let index = 0; index < texts.length; index++) {
    const parts = result.vectors.filter((part) => part.index === index).sort((a, b) => a.part - b.part);
    const length = Array.from(texts[index]).length; // Embedding offsets are Python Unicode code points.
    if (!parts.length || (mode === "query" && parts.length !== 1)) return false;
    let covered = 0;
    for (let n = 0; n < parts.length; n++) {
      const part = parts[n];
      if (part.part !== n || part.start < 0 || part.start > covered || part.end < part.start || part.end > length || (length > 0 && part.end <= covered)) return false;
      covered = part.end;
    }
    if (covered !== length) return false;
  }
  return true;
}

/** One writer builds immutable generations; an atomic alias swap publishes complete indexes. */
export class WikiVectorIndex {
  private syncing: Promise<void> | null = null;
  private signature: string | null = null;
  private currentCollection: string | null = null;
  private generation = { state: "starting", sections: 0, chunks: 0, updated_at: null as string | null, error: null as string | null };
  readonly alias: string;
  constructor(readonly wiki: WikiService, readonly options: VectorOptions) {
    this.alias = options.alias ?? "framework_wiki";
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(this.alias)) throw new Error("Invalid vector alias");
  }

  status() { return { ...this.generation, collection: this.currentCollection, signature: this.signature, model: MODEL, revision: REVISION }; }

  async request(endpoint: string, method = "GET", body?: unknown) {
    const response = await (this.options.fetchImpl ?? fetch)(new URL(endpoint, this.options.qdrantUrl), {
      method, headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`qdrant_${response.status}`);
    return response.json() as Promise<any>;
  }

  async embed(texts: string[], mode: "query" | "passage"): Promise<Embeddings> {
    const response = await (this.options.fetchImpl ?? fetch)(new URL("/embed", this.options.embeddingUrl), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texts, mode }),
      signal: AbortSignal.timeout(mode === "query" ? 20_000 : 180_000)
    });
    if (!response.ok) throw new Error(`embedding_${response.status}`);
    const result = await response.json() as Embeddings;
    if (!validEmbeddings(result, texts, mode)) throw new Error("embedding_contract_mismatch");
    return result;
  }

  async search(query: string, options: SearchOptions = {}) {
    if (!this.currentCollection) {
      try {
        const aliases = await this.request("/aliases");
        this.currentCollection = aliases.result.aliases.find((entry: any) => entry.alias_name === this.alias)?.collection_name ?? null;
      } catch { return { hits: [], status: "unavailable" }; }
    }
    if (!this.currentCollection) return { hits: [], status: this.generation.state };
    try {
      const embedded = await this.embed([query], "query");
      if (embedded.vectors.length !== 1) throw new Error("query_must_not_be_truncated");
      const result = await this.request(`/collections/${this.alias}/points/query`, "POST", {
        query: embedded.vectors[0].vector, limit: 60, with_payload: true, filter: { must: [{ key: "kind", match: { value: "section" } },
          ...(!options.includeHistory ? [{ key: "history", match: { value: false } }] : []),
          ...(["domain", "owner", "verification"] as const).flatMap((key) => options[key] ? [{ key, match: { value: options[key] } }] : [])] }
      });
      const seen = new Set<string>();
      const hits = (result.result?.points ?? []).flatMap((point: any) => {
        const p = point.payload;
        if (!p || typeof p.path !== "string" || typeof p.section_id !== "string" || typeof p.hash !== "string" || !Number.isFinite(point.score)) return [];
        const key = `${p.path}\0${p.section_id}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ path: p.path, section_id: p.section_id, hash: p.hash, score: point.score }];
      });
      return { hits, status: this.generation.state === "ready" ? "ready" : this.generation.state };
    } catch { return { hits: [], status: "unavailable" }; }
  }

  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = this.rebuild().catch((error) => {
      this.generation.state = "unavailable";
      this.generation.error = error instanceof Error && /^[a-z_0-9]+$/.test(error.message) ? error.message : "index_failed";
    }).finally(() => { this.syncing = null; });
    return this.syncing;
  }

  private async sources(): Promise<IndexSection[]> {
    const notes = await this.wiki.listNotes();
    return notes.flatMap((note) => parseSections(note.content).filter((section) => section.content.trim()).map((section) => ({
      path: note.path, section_id: section.section_id, hash: section.hash,
      domain: note.metadata.domain ?? null, owner: note.metadata.owner ?? null, verification: note.metadata.verification ?? null, history: note.path.split("/").includes("사건기록"),
      input: `${note.title}\n${section.headings.join(" > ")}\n${section.content}`
    }))).sort((a, b) => a.path.localeCompare(b.path) || a.section_id.localeCompare(b.section_id));
  }

  private corpusSignature(sections: IndexSection[]) { return hashContent(JSON.stringify({ model: MODEL, revision: REVISION, schema: SCHEMA,
    sources: sections.map((section) => [section.path, section.section_id, section.hash, hashContent(section.input), section.domain, section.owner, section.verification, section.history]) })); }

  private async rebuild() {
    const sections = await this.sources();
    const signature = this.corpusSignature(sections);
    if (signature === this.signature && this.generation.state === "ready") return;
    this.generation.state = "indexing"; this.generation.error = null;
    const collection = `${this.alias}_${signature.slice(0, 24)}`;
    const aliases = await this.request("/aliases");
    const prior = aliases.result.aliases.find((entry: any) => entry.alias_name === this.alias)?.collection_name as string | undefined;
    let complete = false;
    try {
      const manifest = await this.request(`/collections/${collection}/points/${MANIFEST_ID}`);
      complete = manifest.result?.payload?.signature === signature;
      if (complete) this.generation.chunks = manifest.result.payload.chunks;
    } catch { /* A missing manifest marks an absent or interrupted generation. */ }
    if (!complete) {
      // Only our deterministic unpublished generation may be cleared after interruption.
      const listing = await this.request("/collections");
      if (listing.result.collections.some((item: any) => item.name === collection)) {
        if (prior === collection) throw new Error("active_index_missing_manifest");
        await this.request(`/collections/${collection}`, "DELETE");
      }
      await this.request(`/collections/${collection}`, "PUT", { vectors: { size: 384, distance: "Cosine" } });
      await this.request(`/collections/${collection}/index?wait=true`, "PUT", { field_name: "kind", field_schema: "keyword" });
      await fs.mkdir(this.options.cacheDir, { recursive: true, mode: 0o700 });
      let chunks = 0;
      for (const section of sections) {
        const cacheKey = hashContent(`${REVISION}\0${SCHEMA}\0${section.input}`);
        const cachePath = path.join(this.options.cacheDir, `${cacheKey}.json`);
        let embedded: Embeddings | null = null;
        try {
          const cached = JSON.parse(await fs.readFile(cachePath, "utf8")) as Embeddings;
          if (validEmbeddings(cached, [section.input], "passage")) embedded = cached;
        } catch { /* First indexing of this exact text. */ }
        if (!embedded) {
          embedded = await this.embed([section.input], "passage");
          const tempPath = `${cachePath}.${process.pid}.tmp`;
          await fs.writeFile(tempPath, JSON.stringify(embedded), { mode: 0o600 });
          await fs.rename(tempPath, cachePath);
        }
        const points = embedded.vectors.map((part) => ({ id: vectorPointId(`${section.path}\0${section.section_id}\0${cacheKey}\0${part.part}`), vector: part.vector,
          payload: { kind: "section", path: section.path, section_id: section.section_id, hash: section.hash,
            embedding_hash: cacheKey, part: part.part, signature, domain: section.domain, owner: section.owner, verification: section.verification, history: section.history } }));
        if (points.length) await this.request(`/collections/${collection}/points?wait=true`, "PUT", { points });
        chunks += points.length;
        this.generation.chunks = chunks;
      }
      // Changes during a build must never publish an index falsely marked current.
      if (this.corpusSignature(await this.sources()) !== signature) throw new Error("source_changed_during_index");
      await this.request(`/collections/${collection}/points?wait=true`, "PUT", { points: [{ id: MANIFEST_ID, vector: Array(384).fill(0),
        payload: { kind: "manifest", signature, chunks, sections: sections.length, schema: SCHEMA, revision: REVISION } }] });
    }
    if (this.corpusSignature(await this.sources()) !== signature) throw new Error("source_changed_during_index");
    if (prior !== collection) await this.request("/collections/aliases", "POST", { actions: [
      ...(prior ? [{ delete_alias: { alias_name: this.alias } }] : []),
      { create_alias: { alias_name: this.alias, collection_name: collection } }
    ] });
    this.signature = signature; this.currentCollection = collection;
    this.generation = { state: "ready", sections: sections.length, chunks: this.generation.chunks, updated_at: new Date().toISOString(), error: null };
    // Keep the previous generation for rollback. Operators prune older generations explicitly.
  }
}
