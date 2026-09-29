import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WikiService } from "../src/wiki.js";
import { WikiVectorIndex, vectorPointId } from "../src/vector.js";

function backend() {
  const collections = new Map<string, Map<string, any>>();
  let current: string | null = null;
  let embeddings = 0;
  let failUpsert = false;
  let lastQuery: any;
  const vector = Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0);
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/embed") {
      embeddings++;
      return Response.json({ model: "intfloat/multilingual-e5-small", revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3", schema: "e5-small-480-overlap48-v1",
        vectors: [{ index: 0, part: 0, start: 0, end: body.texts[0].length, vector }] });
    }
    if (url.pathname === "/aliases") return Response.json({ result: { aliases: current ? [{ alias_name: "framework_wiki", collection_name: current }] : [] } });
    if (url.pathname === "/collections/aliases") {
      current = body.actions.find((action: any) => action.create_alias).create_alias.collection_name;
      assert.ok([...collections.get(current!)!.values()].some((point) => point.payload.kind === "manifest"), "alias must not expose an incomplete index");
      return Response.json({ result: true });
    }
    if (url.pathname === "/collections") return Response.json({ result: { collections: [...collections.keys()].map((name) => ({ name })) } });
    const parts = url.pathname.split("/");
    const name = parts[2] === "framework_wiki" ? current! : parts[2];
    if (parts[3] === "index") return Response.json({ result: true });
    if (parts[3] === "points" && parts[4] === "query") {
      lastQuery = body;
      return Response.json({ result: { points: [...collections.get(name)!.values()].filter((point) => point.payload.kind === "section").flatMap((point) => [{ ...point, score: 0.9 }, { ...point, score: 0.8 }]) } });
    }
    if (parts[3] === "points" && parts[4]) {
      const point = collections.get(name)?.get(parts[4]);
      return Response.json(point ? { result: point } : {}, { status: point ? 200 : 404 });
    }
    if (parts[3] === "points") {
      if (failUpsert) return Response.json({}, { status: 503 });
      for (const point of body.points) collections.get(name)!.set(point.id, point);
      return Response.json({ result: true });
    }
    if (init?.method === "DELETE") collections.delete(name);
    else if (init?.method === "PUT") collections.set(name, new Map());
    return Response.json({ result: true });
  };
  return { fetchImpl, collections, get current() { return current; }, get embeddings() { return embeddings; }, get lastQuery() { return lastQuery; }, fail() { failUpsert = true; } };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-vector-test-"));
  const notes = path.join(root, "wiki"); await mkdir(notes);
  await writeFile(path.join(notes, "one.md"), "---\ndomain: client\n---\n# 방송\n얼굴을 보호한다.\n");
  return { root, notes, wiki: new WikiService(notes), cacheDir: path.join(root, "cache") };
}

test("vector generations publish only after complete indexing, cache unchanged text, and collapse chunk duplicates", async () => {
  const f = await fixture(), api = backend();
  try {
    const index = new WikiVectorIndex(f.wiki, { qdrantUrl: "http://qdrant", embeddingUrl: "http://embed", cacheDir: f.cacheDir, fetchImpl: api.fetchImpl });
    await index.sync();
    assert.equal(index.status().state, "ready");
    const calls = api.embeddings;
    await index.sync(); assert.equal(api.embeddings, calls);
    const search = await index.search("개인정보 보호", { domain: "client" });
    assert.equal(search.hits.length, 1);
    assert.ok(api.lastQuery.filter.must.some((item: any) => item.key === "domain" && item.match.value === "client"));
    assert.ok(api.lastQuery.filter.must.some((item: any) => item.key === "history" && item.match.value === false));
    await writeFile(path.join(f.notes, "two.md"), "# 연결\n네트워크 연결 복구\n");
    await index.sync();
    assert.equal(api.embeddings, calls + 2, "query plus only the new section should require embeddings");
    assert.equal(index.status().sections, 2);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("failed generation never replaces the working alias", async () => {
  const f = await fixture(), api = backend();
  try {
    const index = new WikiVectorIndex(f.wiki, { qdrantUrl: "http://qdrant", embeddingUrl: "http://embed", cacheDir: f.cacheDir, fetchImpl: api.fetchImpl });
    await index.sync(); const prior = api.current;
    await writeFile(path.join(f.notes, "one.md"), "# 방송\n수정한 내용\n"); api.fail();
    await index.sync();
    assert.equal(index.status().state, "unavailable");
    assert.equal(api.current, prior);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("point identity is stable and distinguishes source versions", () => {
  assert.equal(vectorPointId("a"), vectorPointId("a"));
  assert.notEqual(vectorPointId("a"), vectorPointId("b"));
  assert.match(vectorPointId("a"), /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-8[\da-f]{3}-[\da-f]{12}$/);
});
