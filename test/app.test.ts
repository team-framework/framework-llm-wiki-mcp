import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { buildApp } from "../src/app.js";

async function setup(auth: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-api-test-"));
  await writeFile(path.join(root, "연결 방법.md"), "# 연결 방법\n\n## 확인\n연결 상태를 확인한다.\n");
  Object.assign(process.env, { WIKI_ROOT: root, AUTH_MODE: auth ? "github" : "disabled", GITHUB_CLIENT_ID: "test-client", GITHUB_CLIENT_SECRET: "test-secret", SESSION_SECRET: "test-session-secret",
    PUBLIC_BASE_URL: "https://wiki.example.com", WIKI_SERVICE_KEY: "readonly-service-key-at-least-32-chars" });
  for (const key of ["QDRANT_URL", "EMBEDDING_URL", "WIKI_WEB_URL", "HERMES_WIKI_URL", "HERMES_WIKI_KEY"]) delete process.env[key];
  const app = await buildApp();
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
