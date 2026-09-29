import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { buildApp } from "../src/app.js";
import { GitHubAuth } from "../src/auth.js";

async function setup(enabled = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-measurement-api-")); const filename = path.join(root, "measurements.sqlite");
  await writeFile(path.join(root, "안내.md"), "# 안내\n\n## 검색\n팀은 검색 결과의 근거를 확인한다.\n");
  Object.assign(process.env, { WIKI_ROOT: root, AUTH_MODE: "github", GITHUB_CLIENT_ID: "test-client", GITHUB_CLIENT_SECRET: "test-secret", SESSION_SECRET: "test-session-secret",
    PUBLIC_BASE_URL: "https://wiki.example.com", WIKI_SERVICE_KEY: "readonly-service-key-at-least-32-chars", WIKI_MEASUREMENT_SECRET: "measurement-secret-at-least-32-characters", WIKI_MEASUREMENT_RELEASE: "test-release" });
  if (enabled) process.env.WIKI_MEASUREMENT_PATH = filename; else delete process.env.WIKI_MEASUREMENT_PATH;
  for (const key of ["QDRANT_URL", "EMBEDDING_URL", "WIKI_WEB_URL", "ALLOWED_ORIGINS", "WIKI_MEASUREMENT_MODE"]) delete process.env[key];
  const auth = new GitHubAuth();
  const tokens = (login: string) => (auth as any).issueTokens(login, auth.resourceUrl).access_token as string;
  const headers = (login = "first-member") => ({ authorization: `Bearer ${tokens(login)}` });
  const cookie = `framework_wiki_session=${(auth as any).sign({ login: "first-member", expiresAt: Date.now() + 60_000 })}`;
  const app = await buildApp();
  const rows = () => { const db = new DatabaseSync(filename, { readOnly: true }); try { return db.prepare("SELECT actor_kind,client,feature,facts FROM events ORDER BY ts,rowid").all() as any[]; } finally { db.close(); } };
  return { app, headers, cookie, rows, cleanup: async () => { await app.close(); await rm(root, { recursive: true, force: true }); delete process.env.WIKI_MEASUREMENT_PATH; } };
}

async function answer(f: Awaited<ReturnType<typeof setup>>, login = "first-member") {
  const original = globalThis.fetch;
  process.env.HERMES_WIKI_URL = "http://private-provider.test"; process.env.HERMES_WIKI_KEY = "test-secret";
  globalThis.fetch = async () => Response.json({ answer: "[1] 검색 근거를 확인한다.", model: "gpt-6-luna", usage: { input_tokens: 20, output_tokens: 10 } });
  try { const result = await f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers(login), payload: { message: "검색 근거를 확인하는 방법" } }); assert.equal(result.statusCode, 200); return result.json(); }
  finally { globalThis.fetch = original; delete process.env.HERMES_WIKI_URL; delete process.env.HERMES_WIKI_KEY; }
}

test("search remains an array with a measured event header; SSR note reads do not count document views", async () => {
  const f = await setup();
  try {
    const search = await f.app.inject({ method: "GET", url: "/api/search?q=" + encodeURIComponent("검색 private-query-never-store"), headers: f.headers() });
    assert.equal(search.statusCode, 200); assert.ok(Array.isArray(search.json())); assert.match(search.headers["x-wiki-event"] as string, /^[0-9a-f-]{36}$/);
    await f.app.inject({ method: "GET", url: "/api/note?path=" + encodeURIComponent("안내.md"), headers: f.headers() });
    await f.app.inject({ method: "GET", url: "/api/outline?path=" + encodeURIComponent("안내.md"), headers: f.headers() });
    const opened = await f.app.inject({ method: "POST", url: "/api/events", headers: f.headers(), payload: { feature: "web.document_view", path: "안내.md" } });
    assert.equal(opened.statusCode, 200);
    const rows = f.rows(); assert.deepEqual(rows.map((row) => row.feature), ["web.search", "web.document_view"]);
    assert.ok(!JSON.stringify(rows).includes("private-query-never-store")); assert.ok(!JSON.stringify(rows).includes("안내.md"));
  } finally { await f.cleanup(); }
});

test("service retrieval is measured separately and cannot read statistics or submit feedback", async () => {
  const f = await setup();
  try {
    const service = { authorization: `Bearer ${process.env.WIKI_SERVICE_KEY}` };
    assert.equal((await f.app.inject({ method: "GET", url: "/api/context?q=" + encodeURIComponent("검색"), headers: service })).statusCode, 200);
    const rows = f.rows(); assert.equal(rows[0].feature, "discord.context"); assert.equal(rows[0].actor_kind, "service"); assert.equal(rows[0].client, "discord");
    assert.equal((await f.app.inject({ method: "GET", url: "/api/measurements", headers: service })).statusCode, 401);
    assert.equal((await f.app.inject({ method: "GET", url: "/api/product-feedback", headers: service })).statusCode, 401);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/feedback", headers: service, payload: {} })).statusCode, 401);
  } finally { await f.cleanup(); }
});

test("measurement writes enforce cookie origin and parent event ownership", async () => {
  const f = await setup();
  try {
    const payload = { feature: "web.document_view", path: "안내.md" };
    assert.equal((await f.app.inject({ method: "POST", url: "/api/events", headers: { cookie: f.cookie }, payload })).statusCode, 403);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/events", headers: { cookie: f.cookie, origin: "https://wiki.example.com" }, payload })).statusCode, 200);
    const search = await f.app.inject({ method: "GET", url: "/api/search?q=" + encodeURIComponent("검색"), headers: f.headers() });
    const opening = { feature: "web.search_open", path: "안내.md", parent_event_id: search.headers["x-wiki-event"] };
    assert.equal((await f.app.inject({ method: "POST", url: "/api/events", headers: f.headers("second-member"), payload: opening })).statusCode, 400);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/events", headers: f.headers(), payload: opening })).statusCode, 200);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/events", headers: f.headers(), payload: { ...opening, feature: "web.citation_open" } })).statusCode, 400);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/events", headers: f.headers(), payload: { ...payload, path: "../escape.md" } })).statusCode, 400);
  } finally { await f.cleanup(); }
});

test("chat feedback belongs to the answer recipient and rejects arbitrary free text reasons", async () => {
  const f = await setup();
  try {
    const result = await answer(f); assert.match(result.measurement_id, /^[0-9a-f-]{36}$/);
    const payload = { event_id: result.measurement_id, rating: "positive", reason: "correct" };
    assert.equal((await f.app.inject({ method: "POST", url: "/api/feedback", headers: f.headers("second-member"), payload })).statusCode, 404);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/feedback", headers: f.headers(), payload: { ...payload, reason: "private comment" } })).statusCode, 400);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/feedback", headers: f.headers(), payload })).statusCode, 200);
    const report = await f.app.inject({ method: "GET", url: "/api/measurements?days=7", headers: f.headers() });
    assert.equal(report.statusCode, 200); assert.equal(report.json().feedback.responses, 1); assert.equal(report.json().feedback.positive, 1);
    assert.equal((await f.app.inject({ method: "GET", url: "/api/measurements?days=8", headers: f.headers() })).statusCode, 400);
  } finally { await f.cleanup(); }
});

test("product feedback stores explicit team feedback with optional bounded diagnostics", async () => {
  const f = await setup();
  try {
    const payload = { categories: ["search_miss"], details: "검색 결과의 제목을 읽기 어려워요.", diagnostics: { page_path: "/docs/guide", viewport_width: 1200, viewport_height: 800 } };
    assert.equal((await f.app.inject({ method: "POST", url: "/api/product-feedback", headers: { cookie: f.cookie }, payload })).statusCode, 403);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/product-feedback", headers: f.headers(), payload: { ...payload, diagnostics: { ...payload.diagnostics, page_path: "/docs/guide?token=private" } } })).statusCode, 400);
    const created = await f.app.inject({ method: "POST", url: "/api/product-feedback", headers: f.headers(), payload }); assert.equal(created.statusCode, 200); assert.ok(created.json().feedback_id);
    const list = await f.app.inject({ method: "GET", url: "/api/product-feedback?limit=20", headers: f.headers("second-member") });
    assert.equal(list.statusCode, 200); assert.equal(list.json().feedback.length, 1); assert.ok(!JSON.stringify(list.json()).includes("first-member"));
  } finally { await f.cleanup(); }
});

test("disabled measurements leave search responses usable and report disabled state", async () => {
  const f = await setup(false);
  try {
    const search = await f.app.inject({ method: "GET", url: "/api/search?q=test", headers: f.headers() }); assert.equal(search.statusCode, 200); assert.ok(Array.isArray(search.json())); assert.equal(search.headers["x-wiki-event"], undefined);
    const event = await f.app.inject({ method: "POST", url: "/api/events", headers: f.headers(), payload: { feature: "web.document_view" } }); assert.equal(event.json().measurement_status, "disabled");
    assert.equal((await f.app.inject({ method: "GET", url: "/api/measurements", headers: f.headers() })).json().status, "disabled");
  } finally { await f.cleanup(); }
});

test("MCP calls retain their compact payload and produce one tool event; status stays unmeasured", async () => {
  const f = await setup();
  try {
    const headers = { ...f.headers(), accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" };
    const call = await f.app.inject({ method: "POST", url: "/mcp", headers, payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_context", arguments: { query: "검색", max_chars: 12000 } } } });
    assert.equal(call.statusCode, 200);
    const event = call.body.startsWith("data:") ? JSON.parse(call.body.split("data: ")[1].split("\n")[0]) : JSON.parse(call.body.slice(call.body.indexOf("data: ") + 6).split("\n")[0]);
    const payload = JSON.parse(event.result.content[0].text); assert.ok(payload.evidence.length); assert.equal(payload.measurement_id, undefined);
    const rows = f.rows(); assert.equal(rows.length, 1); assert.equal(rows[0].client, "mcp"); assert.equal(rows[0].feature, "mcp.get_context");
    await f.app.inject({ method: "POST", url: "/mcp", headers, payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_wiki_status", arguments: {} } } });
    assert.equal(f.rows().length, 1);
  } finally { await f.cleanup(); }
});

test("provider failures record only an error counter while feedback limits remain bounded", async () => {
  const f = await setup();
  try {
    delete process.env.HERMES_WIKI_URL; delete process.env.HERMES_WIKI_KEY;
    const chat = await f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers(), payload: { message: "private-provider-failure-query" } });
    assert.equal(chat.statusCode, 503); const rows = f.rows(); assert.equal(rows[0].feature, "web.chat"); assert.ok(!JSON.stringify(rows).includes("private-provider-failure-query"));
    for (let index = 0; index < 10; index++) assert.equal((await f.app.inject({ method: "POST", url: "/api/product-feedback", headers: f.headers(), payload: { categories: ["other"], details: "팀 검토용 의견" } })).statusCode, 200);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/product-feedback", headers: f.headers(), payload: { categories: ["other"], details: "팀 검토용 의견" } })).statusCode, 429);
  } finally { await f.cleanup(); }
});

test("tree labels use human display titles while MCP complete reads do not duplicate display payloads", async () => {
  const f = await setup();
  try {
    await writeFile(path.join(process.env.WIKI_ROOT!, "표시.md"), "---\nDisplayTitle: 사람용 제목\nDisplayContent: |\n  사람이 읽는 소개문\n---\n# canonical-source\n\n에이전트가 읽는 원문이다.\n");
    const tree = await f.app.inject({ method: "GET", url: "/api/tree", headers: f.headers() }); assert.equal(tree.json().find((entry: any) => entry.path === "표시.md").title, "사람용 제목");
    const note = await f.app.inject({ method: "GET", url: "/api/note?path=" + encodeURIComponent("표시.md"), headers: f.headers() }); assert.equal(note.json().display.title, "사람용 제목");
    const { compactNote } = await import("../src/mcp.js"); const compact = compactNote(note.json()); assert.equal((compact as any).display, undefined); assert.equal((compact as any).body, undefined); assert.equal(compact.content, note.json().content);
  } finally { await f.cleanup(); }
});
