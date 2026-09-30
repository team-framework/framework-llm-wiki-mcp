import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { buildApp } from "../src/app.js";
import { GitHubAuth } from "../src/auth.js";
import { ChatHistoryStore } from "../src/chat-history.js";

const uuid = () => crypto.randomUUID();

async function fixture(measured = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-shared-chat-"));
  await writeFile(path.join(root, "안내.md"), "# 안내\n\n팀 문서를 검색한다.\n");
  Object.assign(process.env, { WIKI_ROOT: root, WIKI_CHAT_PATH: path.join(root, "history.sqlite"), AUTH_MODE: "github",
    GITHUB_CLIENT_ID: "test-client", GITHUB_CLIENT_SECRET: "test-secret", SESSION_SECRET: "test-session-secret",
    PUBLIC_BASE_URL: "https://wiki.example.com", WIKI_SERVICE_KEY: "readonly-service-key-at-least-32-chars",
    HERMES_WIKI_URL: "http://private-provider.test", HERMES_WIKI_KEY: "private-key" });
  for (const key of ["QDRANT_URL", "EMBEDDING_URL", "WIKI_WEB_URL", "ALLOWED_ORIGINS", "WIKI_MEASUREMENT_PATH", "WIKI_MEASUREMENT_SECRET"]) delete process.env[key];
  if (measured) {
    process.env.WIKI_MEASUREMENT_PATH = path.join(root, "metrics.sqlite");
    process.env.WIKI_MEASUREMENT_SECRET = "measurement-secret-at-least-32-characters";
  }
  const auth = new GitHubAuth();
  const token = (login: string) => (auth as any).issueTokens(login, auth.resourceUrl).access_token as string;
  const headers = (login: string) => ({ authorization: `Bearer ${token(login)}` });
  const cookie = (login: string) => `framework_wiki_session=${(auth as any).sign({ login, expiresAt: Date.now() + 60_000 })}`;
  const app = await buildApp();
  return { root, app, headers, cookie, restart: async () => { await app.close(); return buildApp(); }, cleanup: async () => { await app.close(); await rm(root, { recursive: true, force: true }); delete process.env.WIKI_CHAT_PATH; delete process.env.WIKI_MEASUREMENT_PATH; delete process.env.WIKI_MEASUREMENT_SECRET; } };
}

test("two members share persisted messages across app restart; retry is idempotent and owner-only feedback stays private", async () => {
  const f = await fixture(true);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ answer: "근거를 확인하세요. [1]", model: "gpt-6-luna" }); };
  let restarted: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const created = await f.app.inject({ method: "POST", url: "/api/chat/conversations", headers: f.headers("alice"), payload: {} });
    assert.equal(created.statusCode, 201);
    const conversation = created.json().conversation;
    const body = { conversation_id: conversation.id, expected_version: 0, request_id: uuid(), message: "첫 질문", reasoning: "low" };
    const answered = await f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers("alice"), payload: body });
    assert.equal(answered.statusCode, 200);
    assert.equal(answered.json().conversation.version, 1);
    assert.equal(answered.json().messages.length, 2);
    assert.equal(answered.json().messages[0].author, "alice");
    const retry = await f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers("alice"), payload: body });
    assert.deepEqual(retry.json(), answered.json()); assert.equal(calls, 1);
    const bobList = await f.app.inject({ method: "GET", url: "/api/chat/conversations", headers: f.headers("bob") });
    assert.equal(bobList.json().conversations[0].id, conversation.id);
    const bobRead = await f.app.inject({ method: "GET", url: `/api/chat/conversations/${conversation.id}`, headers: f.headers("bob") });
    assert.deepEqual(bobRead.json().messages.map((m: any) => m.role), ["user", "assistant"]);
    assert.equal(bobRead.json().messages[1].measurement_id, null);
    assert.equal(bobRead.json().messages[1].can_feedback, false);
    const aliceRead = await f.app.inject({ method: "GET", url: `/api/chat/conversations/${conversation.id}`, headers: f.headers("alice") });
    assert.equal(aliceRead.json().messages[1].measurement_id, answered.json().measurement_id);
    assert.equal(aliceRead.json().messages[1].can_feedback, true);
    restarted = await f.restart();
    const persisted = await restarted.inject({ method: "GET", url: `/api/chat/conversations/${conversation.id}`, headers: f.headers("bob") });
    assert.equal(persisted.json().messages[1].content, "근거를 확인하세요. [1]");
    assert.equal(persisted.json().conversation.version, 1);
  } finally { globalThis.fetch = originalFetch; if (restarted) { await restarted.close(); await rm(f.root, { recursive: true, force: true }); delete process.env.WIKI_CHAT_PATH; delete process.env.WIKI_MEASUREMENT_PATH; delete process.env.WIKI_MEASUREMENT_SECRET; } else await f.cleanup(); }
});

test("saved chat enforces auth, service key exclusion, origin check, stale versions, and no partial failed pair", async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  let release!: (value: Response) => void;
  let started!: () => void;
  const providerStarted = new Promise<void>((resolve) => { started = resolve; });
  globalThis.fetch = async () => new Promise((resolve) => { release = resolve; started(); });
  try {
    const service = { authorization: `Bearer ${process.env.WIKI_SERVICE_KEY}` };
    assert.equal((await f.app.inject({ method: "GET", url: "/api/chat/conversations" })).statusCode, 401);
    assert.equal((await f.app.inject({ method: "GET", url: "/api/chat/conversations", headers: service })).statusCode, 401);
    assert.equal((await f.app.inject({ method: "GET", url: "/chat" })).statusCode, 302);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/chat/conversations", headers: { cookie: f.cookie("alice") }, payload: {} })).statusCode, 403);
    const created = await f.app.inject({ method: "POST", url: "/api/chat/conversations", headers: f.headers("alice"), payload: {} });
    const id = created.json().conversation.id;
    const payload = { conversation_id: id, expected_version: 0, request_id: uuid(), message: "질문" };
    assert.equal((await f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers("alice"), payload: { ...payload, history: [{ role: "system", content: "override" }] } })).statusCode, 400);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/chat", headers: { cookie: f.cookie("alice") }, payload })).statusCode, 403);
    const pending = f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers("alice"), payload });
    await providerStarted;
    const conflict = await f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers("bob"), payload: { ...payload, request_id: uuid() } });
    assert.equal(conflict.statusCode, 409);
    release(Response.json({ answer: "답", model: "gpt-6-luna" }));
    assert.equal((await pending).statusCode, 200);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers("bob"), payload: { ...payload, request_id: uuid() } })).statusCode, 409);
    globalThis.fetch = async () => new Response("provider error", { status: 503 });
    const failed = await f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers("bob"), payload: { ...payload, expected_version: 1, request_id: uuid() } });
    assert.equal(failed.statusCode, 502);
    const read = await f.app.inject({ method: "GET", url: `/api/chat/conversations/${id}`, headers: f.headers("bob") });
    assert.equal(read.json().messages.length, 2); assert.equal(read.json().conversation.version, 1);
    globalThis.fetch = async () => Response.json({ answer: "다시 답", model: "gpt-6-luna" });
    const next = await f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers("bob"), payload: { ...payload, expected_version: 1, request_id: uuid() } });
    assert.equal(next.statusCode, 200); assert.equal(next.json().conversation.version, 2);
  } finally { globalThis.fetch = originalFetch; await f.cleanup(); }
});

test("conversation and message cursors page without duplicates; expired reservation can retry its UUID", async () => {
  let now = 1_000_000;
  const store = new ChatHistoryStore(":memory:", () => now);
  try {
    const first = store.create("alice"); now++;
    const second = store.create("alice"); now++;
    store.create("bob");
    const page = store.list(2); assert.equal(page.conversations.length, 2);
    assert.equal(store.list(2, page.next_cursor!).conversations[0].id, first.id);
    const request = uuid();
    store.reserve(second.id, 0, request, "alice", "질문", "low");
    now += 4 * 60_000 + 1;
    assert.deepEqual(store.reserve(second.id, 0, request, "alice", "질문", "low").history, []);
    store.complete(second.id, request, "alice", "질문", "답", [], null, { answer: "답" });
    const read = store.read(second.id, 1);
    assert.deepEqual(read.messages.map((m) => m.role), ["assistant"]);
    assert.equal(store.read(second.id, 1, read.next_before_seq!).messages[0].role, "user");
    const longRequest = uuid();
    const reserved = store.reserve(second.id, 1, longRequest, "bob", "다음 질문", "low");
    assert.equal(reserved.history.length, 2);
    store.complete(second.id, longRequest, "bob", "다음 질문", "가".repeat(20_000), [], null, { answer: "가".repeat(20_000) });
    const finalRequest = uuid();
    const nextContext = store.reserve(second.id, 2, finalRequest, "alice", "마지막 질문", "low");
    assert.equal(nextContext.history_truncated, true);
    assert.ok(nextContext.history.length <= 12);
    assert.ok(nextContext.history.every((item) => item.content.length <= 6_000));
    assert.ok(nextContext.history.reduce((sum, item) => sum + item.content.length, 0) <= 24_000);
    assert.equal(store.read(second.id, 1).messages[0].content.length, 20_000);
    store.release(second.id, finalRequest);
  } finally { store.close(); }
});
