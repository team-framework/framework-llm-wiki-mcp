import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NotionError, NotionService } from "../src/notion.js";
import { NotionIndex } from "../src/sources.js";

const root = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const id = (n: number) => n.toString(16).padStart(32, "0");
function tree() {
  const calls: string[] = []; const bodies: string[] = []; let changed = false, removed = false, denied = false, failing = false, partial = false, corruptCursor = false;
  const page = (value: string) => ({ id: value, object: "page", last_edited_time: value === id(1) && changed ? "2026-10-02" : "2026-10-01", parent: value === root ? { type: "workspace", workspace: true } : { type: "page_id", page_id: root }, properties: { title: { type: "title", title: [{ plain_text: value === id(2101) ? "오래된 얼굴 합성 실험" : value }] } } });
  const service = new NotionService({ token: "secret", rootIds: [root], intervalMs: 0, pause: async () => {}, fetchImpl: async (input, init) => {
    const url = new URL(String(input)); calls.push(url.pathname);
    if (url.pathname === "/v1/search") throw new Error("Title search must not enumerate documents");
    const match = url.pathname.match(/^\/v1\/pages\/([a-f0-9]+)(\/markdown)?$/);
    if (match) {
      if (match[1] === id(1) && denied) return new Response("", { status: 404 });
      if (!match[2]) return Response.json(page(match[1]));
      bodies.push(match[1]);
      if (match[1] === id(1) && failing) return new Response("", { status: 500 });
      return Response.json({ markdown: `# ${match[1]}\n\n${match[1] === id(2101) ? "FaceSwapS 정량 평가 0.2196" : changed ? "수정됨" : "원문"}`, truncated: match[1] === id(1) && partial, unknown_block_ids: [] });
    }
    if (url.pathname === `/v1/blocks/${root}/children`) {
      const offset = Number(url.searchParams.get("start_cursor") ?? 0);
      const count = 2101; const end = Math.min(count, offset + 100);
      const results: any[] = Array.from({ length: end - offset }, (_, n) => ({ id: id(offset + n + 1), type: "child_page" })).filter((b) => !(removed && b.id === id(1)));
      if (!offset) results.push({ id: id(8000), type: "toggle", has_children: true }, { id: id(9000), type: "child_database" });
      return Response.json({ results, has_more: end < count, next_cursor: end < count ? String(corruptCursor ? 100 : end) : null });
    }
    if (url.pathname === `/v1/blocks/${id(8000)}/children`) return Response.json({ results: [{ id: id(8001), type: "child_page" }, { id: id(1), type: "child_page" }], has_more: false });
    if (url.pathname === `/v1/databases/${id(9000)}`) return Response.json({ id: id(9000), parent: { type: "page_id", page_id: root }, data_sources: [{ id: id(9001) }] });
    if (url.pathname === `/v1/data_sources/${id(9001)}`) return Response.json({ id: id(9001), parent: { type: "database_id", database_id: id(9000) } });
    if (url.pathname === `/v1/data_sources/${id(9001)}/query`) {
      const body = JSON.parse(String(init?.body));
      return Response.json({ results: [page(id(body.start_cursor ? 9102 : 9101))], has_more: !body.start_cursor, next_cursor: body.start_cursor ? null : "next-row" });
    }
    if (/^\/v1\/blocks\/[a-f0-9]+\/children$/.test(url.pathname)) return Response.json({ results: [], has_more: false });
    throw new Error("unexpected " + url.pathname);
  } });
  return { service, calls, bodies, change: () => { changed = true; }, remove: () => { removed = true; }, deny: () => { denied = true; }, fail: () => { failing = true; }, partial: () => { partial = true; }, recover: () => { failing = partial = false; }, corrupt: () => { corruptCursor = true; } };
}

test("collects beyond 1000 documents and 20 cursor batches, including nested pages and database rows", async () => {
  const f = tree(); const index = new NotionIndex(f.service); await index.sync();
  assert.equal(index.status().pages, 2105); assert.equal(index.status().truncated, false);
  assert.equal(f.calls.filter((call) => call === `/v1/blocks/${root}/children`).length, 22);
  assert.equal(f.bodies.length, 2105);
  assert.deepEqual((await index.candidates("FaceSwapS")).ids, [id(2101)]);
});
test("refresh reuses unchanged bodies and replaces changed revisions; denied and removed pages leave the index", async () => {
  const f = tree(); const index = new NotionIndex(f.service); await index.sync(); f.bodies.length = 0;
  await index.sync(); assert.equal(f.bodies.length, 0); assert.equal(index.status().reused, 2105);
  f.change(); await index.sync(); assert.deepEqual(f.bodies, [id(1)]);
  f.deny(); f.remove(); await index.sync();
  assert.equal(index.status().removed, 1); assert.equal(index.status().pages, 2104); assert.equal(index.status().truncated, true);
});
test("private persisted bodies survive restart, but a changed connection does not reuse them", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "notion-index-")); const file = path.join(directory, "index.json");
  try {
    const f = tree(); await new NotionIndex(f.service, file).sync(); assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await readFile(file, "utf8")).includes('"secret"'), false);
    f.bodies.length = 0; const restarted = new NotionIndex(f.service, file); await restarted.sync();
    assert.equal(f.bodies.length, 0); assert.equal(restarted.status().reused, 2105);
    f.service.options.token = "replacement"; await new NotionIndex(f.service, file).sync(); assert.equal(f.bodies.length, 2105);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("body failures keep other pages searchable and retry next refresh; incomplete bodies are also retried", async () => {
  const f = tree(); f.fail(); const index = new NotionIndex(f.service); await index.sync();
  assert.equal(index.status().failed, 1); assert.equal(index.status().truncated, true); assert.equal(index.status().pages, 2104);
  f.recover(); f.partial(); await index.sync(); assert.equal(index.status().partial_content, 1);
  f.bodies.length = 0; f.recover(); await index.sync(); assert.deepEqual(f.bodies, [id(1)]); assert.equal(index.status().truncated, false);
});
test("invalid repeated pagination cursors report incomplete collection instead of looping or silently succeeding", async () => {
  const f = tree(); f.corrupt(); const index = new NotionIndex(f.service); await index.sync();
  assert.equal(index.status().state, "unavailable"); assert.equal(index.status().error, "notion_invalid_cursor"); assert.equal(index.status().truncated, true);
});
test("title lookup continues beyond 20 result batches and rejects a missing continuation cursor", async () => {
  let count = 0, invalid = false;
  const service = new NotionService({ token: "secret", rootIds: [root], intervalMs: 0, pause: async () => {}, fetchImpl: async () => {
    count++;
    return Response.json({ results: count <= 21 ? [] : [{ id: root, properties: {} }], has_more: count <= 21, next_cursor: invalid ? null : String(count) });
  } });
  assert.equal((await service.search("오래된 문서")).results.length, 1); assert.equal(count, 22);
  count = 0; invalid = true;
  await assert.rejects(service.search("오래된 문서"), (e: unknown) => e instanceof NotionError && e.code === "notion_invalid_cursor");
});

test("splits capped database queries and traverses nested Wiki data sources", async () => {
  const db = id(10), source = id(11), nested = id(12), row = id(13); let splits = 0;
  const parent = (value: string) => ({ id: value, object: "page", parent: value === root ? { type: "workspace" } : { type: "page_id", page_id: root }, last_edited_time: "2026-10-01" });
  const service = new NotionService({ token: "secret", rootIds: [root], intervalMs: 0, pause: async () => {}, fetchImpl: async (input, init) => {
    const endpoint = new URL(String(input)).pathname;
    if (endpoint === `/v1/pages/${root}` || endpoint === `/v1/pages/${row}`) return Response.json(parent(endpoint.split("/").at(-1)!));
    if (endpoint.endsWith("/markdown")) return Response.json({ markdown: "# 원문", unknown_block_ids: [], truncated: false });
    if (endpoint === `/v1/blocks/${root}/children`) return Response.json({ results: [{ id: db, type: "child_database" }], has_more: false });
    if (endpoint === `/v1/blocks/${row}/children`) return Response.json({ results: [], has_more: false });
    if (endpoint === `/v1/databases/${db}`) return Response.json({ ...parent(db), data_sources: [{ id: source }] });
    if (endpoint === `/v1/data_sources/${source}` || endpoint === `/v1/data_sources/${nested}`) return Response.json(parent(endpoint.split("/").at(-1)!));
    if (endpoint === `/v1/data_sources/${source}/query`) {
      const body = JSON.parse(String(init?.body));
      if (!body.filter) return Response.json({ results: [], has_more: false, request_status: { type: "incomplete", incomplete_reason: "query_result_limit_reached" } });
      splits++;
      const includesNow = Date.parse(body.filter.and[0].created_time.on_or_after) <= Date.now();
      return Response.json({ results: includesNow ? [{ id: nested, object: "data_source" }] : [], has_more: false });
    }
    if (endpoint === `/v1/data_sources/${nested}/query`) return Response.json({ results: [parent(row)], has_more: false });
    throw new Error(endpoint);
  } });
  const index = new NotionIndex(service); await index.sync();
  assert.equal(splits, 2); assert.equal(index.status().pages, 2); assert.equal(index.status().truncated, false);
});

test("simultaneous sync requests share one traversal", async () => {
  const f = tree(); const index = new NotionIndex(f.service);
  const first = index.sync(); assert.equal(first, index.sync()); await first;
  assert.equal(f.bodies.length, 2105);
});
