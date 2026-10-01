import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { buildApp } from "../src/app.js";
import { GitHubAuth } from "../src/auth.js";

async function setup(auth: boolean, options: Parameters<typeof buildApp>[0] = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-api-test-"));
  await writeFile(path.join(root, "연결 방법.md"), "# 연결 방법\n\n## 확인\n연결 상태를 확인한다.\n");
  Object.assign(process.env, { WIKI_ROOT: root, AUTH_MODE: auth ? "github" : "disabled", GITHUB_CLIENT_ID: "test-client", GITHUB_CLIENT_SECRET: "test-secret", SESSION_SECRET: "test-session-secret",
    PUBLIC_BASE_URL: "https://wiki.example.com", WIKI_SERVICE_KEY: "readonly-service-key-at-least-32-chars" });
  for (const key of ["QDRANT_URL", "EMBEDDING_URL", "WIKI_WEB_URL", "HERMES_WIKI_URL", "HERMES_WIKI_KEY"]) delete process.env[key];
  const app = await buildApp(options);
  return { app, cleanup: async () => { await app.close(); await rm(root, { recursive: true, force: true }); } };
}

test("private API denies anonymous access and redirects browser documents to GitHub login", async () => {
  const f = await setup(true);
  try {
    assert.equal((await f.app.inject({ method: "GET", url: "/api/tree" })).statusCode, 401);
    const docs = await f.app.inject({ method: "GET", url: "/docs/bot-guide" });
    assert.equal(docs.statusCode, 302); assert.match(docs.headers.location!, /^https:\/\/github.com\/login\/oauth\/authorize/);
    const key = { authorization: `Bearer ${process.env.WIKI_SERVICE_KEY}` };
    const context = await f.app.inject({ method: "GET", url: "/api/context?q=" + encodeURIComponent("연결"), headers: key });
    assert.equal(context.statusCode, 200); assert.ok(context.json().evidence.length);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/chat", headers: key, payload: { message: "질문" } })).statusCode, 401);
    assert.equal((await f.app.inject({ method: "GET", url: "/api/tree", headers: key })).statusCode, 401);
  } finally { await f.cleanup(); }
});

test("configured Notion HTTP and MCP reads share service authentication and root boundaries", async () => {
  const root = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", outside = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const f = await setup(true, { notionIndex: false, notion: { token: "private-notion-token", rootIds: [root], intervalMs: 0, fetchImpl: async (url) => {
    const endpoint = new URL(String(url)).pathname;
    if (endpoint.endsWith("/markdown")) return Response.json({ markdown: "# FaceSwapS\n\n자체 모델 실험 결과\n", truncated: false, unknown_block_ids: [] });
    if (endpoint === "/v1/search") return Response.json({ results: [], has_more: false });
    return Response.json({ id: endpoint.split("/").at(-1), parent: { type: "workspace", workspace: true }, properties: { title: { type: "title", title: [{ plain_text: "FaceSwapS" }] } } });
  } } });
  const headers = { authorization: `Bearer ${process.env.WIKI_SERVICE_KEY}` };
  try {
    assert.equal((await f.app.inject({ method: "GET", url: `/api/notion/page?id=${root}` })).statusCode, 401);
    const read = await f.app.inject({ method: "GET", url: `/api/notion/page?id=${root}`, headers });
    assert.equal(read.statusCode, 200); assert.equal(read.json().url, `https://app.notion.com/p/${root}`);
    assert.equal(read.headers["cache-control"], "private, no-store"); assert.match(read.json().content, /자체 모델/);
    const rejected = await f.app.inject({ method: "GET", url: `/api/notion/page?id=${outside}`, headers });
    assert.equal(rejected.statusCode, 404); assert.equal(rejected.json().error, "notion_outside_roots");
    const invalid = await f.app.inject({ method: "GET", url: "/api/notion/page?id=https://evil.example", headers });
    assert.equal(invalid.statusCode, 400);
    const mcp = await f.app.inject({ method: "POST", url: "/mcp", headers: { ...headers, accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_notion_page", arguments: { id: root } } } });
    assert.equal(mcp.statusCode, 200);
    const result = JSON.parse(mcp.body.match(/^data: (.+)$/m)?.[1] ?? mcp.body);
    assert.match(result.result.content[0].text, /자체 모델/);
    assert.ok(!JSON.stringify([read.json(), rejected.json(), result]).includes("private-notion-token"));
  } finally { await f.cleanup(); }
});

test("service credential completes MCP read calls but cannot use other methods or private APIs", async () => {
  const f = await setup(true);
  try {
    const headers = { authorization: `Bearer ${process.env.WIKI_SERVICE_KEY}`, accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" };
    const call = (id: number, method: string, params?: object) => f.app.inject({ method: "POST", url: "/mcp", headers, payload: { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) } });
    const result = (body: string) => JSON.parse(body.match(/^data: (.+)$/m)?.[1] ?? body);
    const init = await call(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "discord-bot-test", version: "1.0.0" } });
    assert.equal(init.statusCode, 200); assert.equal(result(init.body).result.serverInfo.name, "framework-llm-wiki");
    const initialized = await f.app.inject({ method: "POST", url: "/mcp", headers, payload: { jsonrpc: "2.0", method: "notifications/initialized" } });
    assert.equal(initialized.statusCode, 202);
    assert.equal((await call(2, "ping")).statusCode, 200);
    const list = await call(3, "tools/list");
    assert.equal(list.statusCode, 200);
    assert.deepEqual(result(list.body).result.tools.map((tool: { name: string }) => tool.name).sort(), [
      "get_context", "get_current_metrics", "get_note_outline", "get_sources_context", "get_wiki_status", "read_note", "read_notion_page", "read_sections", "search_notion", "search_wiki"
    ]);
    const read = await call(4, "tools/call", { name: "read_note", arguments: { path: "연결 방법.md" } });
    assert.equal(read.statusCode, 200);
    assert.match(result(read.body).result.content[0].text, /연결 상태를 확인한다/);
    for (const payload of [
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "future_write_tool", arguments: {} } },
      { jsonrpc: "2.0", id: 6, method: "resources/list" },
      { jsonrpc: "2.0", id: 7, method: "tools/call" },
      [{ jsonrpc: "2.0", id: 8, method: "tools/list" }]
    ]) assert.equal((await f.app.inject({ method: "POST", url: "/mcp", headers, payload })).statusCode, 401);
    assert.equal((await f.app.inject({ method: "POST", url: "/mcp", headers: { ...headers, authorization: "Bearer wrong-key" }, payload: { jsonrpc: "2.0", id: 9, method: "tools/list" } })).statusCode, 401);
    assert.equal((await f.app.inject({ method: "GET", url: "/mcp", headers })).statusCode, 401);
    for (const [method, url] of [["GET", "/api/chat/conversations"], ["GET", "/api/measurements"], ["POST", "/api/sections"], ["POST", "/api/events"]] as const) {
      assert.equal((await f.app.inject({ method, url, headers, ...(method === "POST" ? { payload: {} } : {}) })).statusCode, 401);
    }
    const oauth = new GitHubAuth();
    const accessToken = (oauth as any).issueTokens("team-member", oauth.resourceUrl).access_token as string;
    const person = await f.app.inject({ method: "POST", url: "/mcp", headers: { ...headers, authorization: `Bearer ${accessToken}` }, payload: { jsonrpc: "2.0", id: 10, method: "tools/list" } });
    assert.equal(person.statusCode, 200);
  } finally { await f.cleanup(); }
});

test("API renders known document payload and reports missing notes and malformed input without source leaks", async () => {
  const f = await setup(false);
  try {
    const note = await f.app.inject({ method: "GET", url: "/api/note?path=" + encodeURIComponent("연결 방법.md") });
    assert.equal(note.statusCode, 200); assert.equal(note.json().title, "연결 방법");
    const missing = await f.app.inject({ method: "GET", url: "/api/note?path=missing.md" });
    assert.equal(missing.statusCode, 404); assert.ok(!missing.body.includes("wiki-api-test"));
    const invalid = await f.app.inject({ method: "GET", url: "/api/context?q=hi&max_chars=1" });
    assert.equal(invalid.statusCode, 400);
    const unavailable = await f.app.inject({ method: "POST", url: "/api/chat", payload: { message: "hi" } });
    assert.equal(unavailable.statusCode, 503);
  } finally { await f.cleanup(); }
});
