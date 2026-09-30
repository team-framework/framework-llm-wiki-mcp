import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { GitHubAuth } from "../src/auth.js";
import { isUpdateCommand } from "../src/wiki-update.js";
import { githubFixture } from "./wiki-github-fixture.js";

const old = "---\nowner: alice\n---\n# 연결\n\n기존 안내\n";
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-update-"));
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  await writeFile(path.join(root, "연결.md"), old); await writeFile(path.join(root, "폐기.md"), "# 폐기\n옛 안내\n");
  await writeFile(path.join(root, "bot.pem"), keys.privateKey);
  const previous = { ...process.env }, originalFetch = globalThis.fetch;
  Object.assign(process.env, { WIKI_ROOT: root, WIKI_CHAT_PATH: path.join(root, "chat.sqlite"), AUTH_MODE: "github", GITHUB_CLIENT_ID: "client", GITHUB_CLIENT_SECRET: "secret", SESSION_SECRET: "session-secret",
    PUBLIC_BASE_URL: "https://wiki.example.com", WIKI_SERVICE_KEY: "read-only-key", HERMES_WIKI_URL: "http://provider.test", HERMES_WIKI_KEY: "private-key",
    WIKI_GITHUB_APP_CLIENT_ID: "bot-client", WIKI_GITHUB_APP_PRIVATE_KEY_PATH: path.join(root, "bot.pem"), WIKI_TRACKING_ISSUE: "123", WIKI_GITHUB_REPOSITORY: "team-framework/framework-llm-wiki" });
  for (const name of ["QDRANT_URL", "EMBEDDING_URL", "WIKI_WEB_URL", "ALLOWED_ORIGINS", "WIKI_MEASUREMENT_PATH", "WIKI_MEASUREMENT_SECRET"]) delete process.env[name];
  const github = githubFixture(keys.publicKey, { "연결.md": old, "폐기.md": "# 폐기\n옛 안내\n" });
  let plan: unknown = { summary: "안내를 갱신합니다.", changes: [{ action: "update", path: "연결.md", content: "---\nowner: alice\n---\n# 연결\n\n새 안내\n" }] };
  let providerCalls = 0, providerInput: any;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("http://provider.test")) { providerCalls++; providerInput = JSON.parse(String(init?.body)); return Response.json({ answer: JSON.stringify(plan), model: "gpt-6-luna" }); }
    return github.fetchImpl(url, init);
  };
  const auth = new GitHubAuth();
  const headers = (identity = "alice") => ({ authorization: `Bearer ${(auth as any).issueTokens(identity, auth.resourceUrl).access_token}` });
  let app = await buildApp();
  const create = async () => (await app.inject({ method: "POST", url: "/api/chat/conversations", headers: headers(), payload: {} })).json().conversation;
  const propose = (id: string, message = "/업데이트 연결.md 안내를 수정해", version = 0, requestId = randomUUID()) => app.inject({ method: "POST", url: "/api/chat", headers: headers(), payload: { conversation_id: id, expected_version: version, request_id: requestId, message } });
  const publish = (id: string, identity = "alice") => app.inject({ method: "POST", url: `/api/chat/updates/${id}/publish`, headers: headers(identity), payload: {} });
  return { root, github, headers, create, propose, publish, get app() { return app; }, setPlan: (value: unknown) => { plan = value; }, get calls() { return providerCalls; }, get input() { return providerInput; },
    restart: async () => { await app.close(); app = await buildApp(); }, cleanup: async () => { globalThis.fetch = originalFetch; await app.close(); await rm(root, { recursive: true, force: true }); for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name]; Object.assign(process.env, previous); } };
}

test("recognizes only the explicit update slash command", () => {
  assert.ok(isUpdateCommand(" /업데이트\n생성")); assert.ok(isUpdateCommand("/업데이트"));
  assert.ok(!isUpdateCommand("/업데이트됨")); assert.ok(!isUpdateCommand("문서에 /업데이트라고 쓴다"));
});

test("chat proposal creates, edits, deletes via Bot JWT and persists one Draft PR across retry/restart", async () => {
  const f = await fixture();
  try {
    f.setPlan({ summary: "안내를 갱신하고 폐기 문서를 삭제합니다.", changes: [
      { action: "create", path: "새문서.md", content: "# 새 문서\n\n확인한 결정" },
      { action: "update", path: "연결.md", content: "---\nowner: alice\n---\n# 연결\n\n새 안내" }, { action: "delete", path: "폐기.md" }
    ] });
    const conversation = await f.create(), requestId = randomUUID(), message = "/업데이트 연결.md 수정, 폐기.md 삭제, 새문서.md 생성";
    const proposed = await f.propose(conversation.id, message, 0, requestId);
    assert.equal(proposed.statusCode, 200, proposed.body);
    const update = proposed.json().wiki_update;
    assert.equal(update.changes.length, 3); assert.equal(update.changes[1].before, old);
    assert.equal(proposed.json().messages[1].wiki_update.id, update.id);
    assert.equal(f.input.reasoning, "max"); assert.match(f.input.instructions, /JSON 객체만/);
    assert.ok(JSON.parse(f.input.input).evidence.some((item: any) => item.path === "연결.md" && item.content === old));
    assert.equal((await f.propose(conversation.id, message, 0, requestId)).json().wiki_update.id, update.id); assert.equal(f.calls, 1);
    assert.equal((await f.publish(update.id, "bob")).statusCode, 403);
    const published = await f.publish(update.id); assert.equal(published.statusCode, 200, published.body);
    assert.equal(published.json().wiki_update.status, "published"); assert.equal(f.github.pulls.length, 1); assert.equal(f.github.pulls[0].draft, true);
    const commit = f.github.calls.find((call) => call.endpoint.endsWith("/git/commits") && call.method === "POST")!;
    assert.equal(commit.body.author.name, "framework-harness-sync[bot]"); assert.equal(commit.body.committer.email, "42+framework-harness-sync[bot]@users.noreply.github.com");
    const tree = f.github.calls.find((call) => call.endpoint.endsWith("/git/trees") && call.method === "POST")!;
    assert.equal(tree.body.tree.find((entry: any) => entry.path === "폐기.md").sha, null);
    const token = f.github.calls.find((call) => call.endpoint.endsWith("/access_tokens"))!;
    assert.deepEqual(token.body, { repositories: ["framework-llm-wiki"], permissions: { contents: "write", pull_requests: "write" } });
    assert.equal((await f.publish(update.id)).json().wiki_update.pr_url, published.json().wiki_update.pr_url);
    await f.restart();
    const read = await f.app.inject({ method: "GET", url: `/api/chat/conversations/${conversation.id}`, headers: f.headers("bob") });
    assert.equal(read.json().messages[1].wiki_update.status, "published"); assert.equal(read.json().messages[1].wiki_update.can_publish, false);
    assert.equal((await f.publish(update.id)).statusCode, 200); assert.equal(f.github.pulls.length, 1);
    assert.equal(await import("node:fs/promises").then((fs) => fs.readFile(path.join(f.root, "연결.md"), "utf8")), old);
  } finally { await f.cleanup(); }
});

test("lost GitHub response recovers existing PR without duplicate commit or PR", async () => {
  const f = await fixture();
  try {
    const c = await f.create(), proposal = (await f.propose(c.id)).json().wiki_update;
    f.github.loseNextPrResponse();
    assert.equal((await f.publish(proposal.id)).statusCode, 502); assert.equal(f.github.pulls.length, 1);
    await f.restart(); assert.equal((await f.publish(proposal.id)).statusCode, 200); assert.equal(f.github.pulls.length, 1);
    assert.equal(f.github.calls.filter((call) => call.endpoint.endsWith("/git/commits") && call.method === "POST").length, 1);
  } finally { await f.cleanup(); }
});

test("changed source and create collision return conflict before publishing", async () => {
  const f = await fixture();
  try {
    const c = await f.create(), update = (await f.propose(c.id)).json().wiki_update;
    f.github.changeBase("연결.md", "# 바뀐 원본");
    const result = await f.publish(update.id); assert.equal(result.statusCode, 409); assert.equal(result.json().error, "stale_update"); assert.equal(f.github.pulls.length, 0);
    f.setPlan({ summary: "생성", changes: [{ action: "create", path: "연결.md", content: "# 충돌" }] });
    assert.equal((await f.propose(c.id, "/업데이트 연결.md 생성", 1)).statusCode, 409);
  } finally { await f.cleanup(); }
});

test("auth, read-only service key, CSRF and forged payloads cannot publish", async () => {
  const f = await fixture();
  try {
    const url = `/api/chat/updates/${randomUUID()}/publish`;
    assert.equal((await f.app.inject({ method: "POST", url, payload: {} })).statusCode, 401);
    assert.equal((await f.app.inject({ method: "POST", url, headers: { authorization: "Bearer read-only-key" }, payload: {} })).statusCode, 401);
    const auth = new GitHubAuth(), cookie = `framework_wiki_session=${(auth as any).sign({ login: "alice", expiresAt: Date.now() + 60000 })}`;
    assert.equal((await f.app.inject({ method: "POST", url, headers: { cookie }, payload: {} })).statusCode, 403);
    assert.equal((await f.app.inject({ method: "POST", url, headers: f.headers(), payload: { changes: [] } })).statusCode, 400);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers(), payload: { message: "/업데이트" } })).statusCode, 400);
    assert.equal(f.github.calls.length, 0);
  } finally { await f.cleanup(); }
});

test("invalid paths, duplicate targets, unknown originals, bad YAML, and unsolicited deletion are rejected", async () => {
  const f = await fixture();
  try {
    const invalidPlans = [
      { summary: "생성", changes: [{ action: "create", path: "../outside.md", content: "# 외부" }] },
      { summary: "생성", changes: [{ action: "create", path: ".github/test.md", content: "# 설정" }] },
      { summary: "생성", changes: [{ action: "create", path: "새.md", content: "# 생성" }, { action: "create", path: "새.md", content: "# 중복" }] },
      { summary: "수정", changes: [{ action: "update", path: "없음.md", content: "# 없음" }] },
      { summary: "수정", changes: [{ action: "update", path: "연결.md", content: "---\nbad: [\n---\n# 오류" }] },
      { summary: "삭제", changes: [{ action: "delete", path: "연결.md" }] }
    ];
    const c = await f.create();
    for (const plan of invalidPlans) { f.setPlan(plan); const response = await f.propose(c.id); assert.ok(response.statusCode >= 400, response.body); }
    assert.equal(f.github.calls.length, 0);
    const read = await f.app.inject({ method: "GET", url: `/api/chat/conversations/${c.id}`, headers: f.headers() });
    assert.equal(read.json().conversation.version, 0); assert.equal(read.json().messages.length, 0);
  } finally { await f.cleanup(); }
});

test("unclear update asks for details and missing Bot configuration has a useful error", async () => {
  const f = await fixture();
  try {
    f.setPlan({ summary: "어느 문서의 어떤 내용을 바꿀까요?", changes: [] });
    const c = await f.create(), response = await f.propose(c.id, "/업데이트");
    assert.equal(response.statusCode, 200); assert.equal(response.json().wiki_update, undefined); assert.match(response.json().answer, /어느 문서/);
    delete process.env.WIKI_GITHUB_APP_CLIENT_ID; await f.restart();
    const unavailable = await f.propose(c.id, "/업데이트", 1);
    assert.equal(unavailable.statusCode, 503); assert.equal(unavailable.json().error, "update_unavailable");
  } finally { await f.cleanup(); }
});

test("Bot slug mismatch prevents token issuance and concurrent publishing returns busy", async () => {
  const f = await fixture();
  try {
    const c = await f.create(), proposal = (await f.propose(c.id)).json().wiki_update;
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => String(url).endsWith("/app") ? Response.json({ id: 1, slug: "different-app" }) : original(url, init);
    const wrong = await f.publish(proposal.id); assert.equal(wrong.statusCode, 503); assert.equal(wrong.json().error, "wrong_wiki_bot");
    assert.ok(!f.github.calls.some((call) => call.endpoint.endsWith("/access_tokens")));
    let started!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; }), blocked = new Promise<void>((resolve) => { release = resolve; });
    globalThis.fetch = async (url, init) => { if (String(url).endsWith("/app")) { started(); await blocked; } return original(url, init); };
    const first = f.publish(proposal.id); await ready;
    assert.equal((await f.publish(proposal.id)).statusCode, 409);
    release(); assert.equal((await first).statusCode, 200); assert.equal(f.github.pulls.length, 1);
  } finally { await f.cleanup(); }
});

test("changed existing proposal branch is not reused after a lost PR response", async () => {
  const f = await fixture();
  try {
    const c = await f.create(), proposal = (await f.propose(c.id)).json().wiki_update;
    f.github.loseNextPrResponse(); assert.equal((await f.publish(proposal.id)).statusCode, 502);
    f.github.commits.get("new-commit")!.set("연결.md", "# 누군가 바꾼 브랜치\n");
    const retry = await f.publish(proposal.id); assert.equal(retry.statusCode, 409); assert.equal(retry.json().error, "update_branch_changed");
    assert.equal(f.github.pulls.length, 1);
  } finally { await f.cleanup(); }
});

test("a remotely created file conflicts with a reviewed create proposal", async () => {
  const f = await fixture();
  try {
    f.setPlan({ summary: "새 문서", changes: [{ action: "create", path: "새문서.md", content: "# 새 문서\n" }] });
    const c = await f.create(), proposal = (await f.propose(c.id)).json().wiki_update;
    f.github.changeBase("새문서.md", "# 다른 팀원이 먼저 생성\n");
    const response = await f.publish(proposal.id); assert.equal(response.statusCode, 409); assert.equal(f.github.pulls.length, 0);
  } finally { await f.cleanup(); }
});

test("subsequent update uses the previous proposal content as an unmerged draft", async () => {
  const f = await fixture();
  try {
    const c = await f.create(); assert.equal((await f.propose(c.id)).statusCode, 200);
    f.setPlan({ summary: "제안 내용을 다듬습니다.", changes: [{ action: "update", path: "연결.md", content: "---\nowner: alice\n---\n# 연결\n\n새 안내와 후속 설명\n" }] });
    assert.equal((await f.propose(c.id, "/업데이트 연결.md 변경안에 후속 설명 추가", 1)).statusCode, 200);
    const history = JSON.parse(f.input.input).history;
    assert.ok(history.some((message: any) => message.role === "assistant" && message.content.includes("새 안내") && message.content.includes("병합 여부는 별도 확인")));
  } finally { await f.cleanup(); }
});
