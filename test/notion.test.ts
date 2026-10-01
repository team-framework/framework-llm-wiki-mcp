import assert from "node:assert/strict";
import test from "node:test";
import { NotionError, NotionService, notionId, notionLinks } from "../src/notion.js";
import { NotionIndex, SourceContext } from "../src/sources.js";
import type { WikiService } from "../src/wiki.js";

const root = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", child = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", outside = "cccccccccccccccccccccccccccccccc", database = "dddddddddddddddddddddddddddddddd", subtree = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
function fixture() {
  const calls: string[] = []; let edited = "2026-10-01T00:00:00Z", allowed = true, underRoot = true, parentType = "page_id", markdown = "# 서버\n\n배포 절차\n\n| 설정 | 값 |\n| --- | --- |\n| 서버 | chaeyn |\n";
  let unknown: string[] = []; let archived = false; let retries = 0;
  const pauseCalls: number[] = [];
  const entity = (id: string) => ({ id, object: "page", last_edited_time: edited, archived: id === child && archived, parent: id === root || id === outside || !underRoot ? { type: "workspace", workspace: true } : { type: parentType, [parentType]: parentType === "page_id" ? root : database }, properties: { title: { type: "title", title: [{ plain_text: id === root ? "Framework" : "서버" }] } } });
  const service = new NotionService({ token: "secret-notion-token", rootIds: [root], intervalMs: 0, pause: async (ms) => { pauseCalls.push(ms); }, fetchImpl: async (url, init) => {
    const endpoint = new URL(String(url)).pathname; calls.push(endpoint);
    assert.equal((init?.headers as Record<string, string>)["Notion-Version"], "2026-03-11"); assert.equal(init?.redirect, "error");
    if (retries-- > 0) return new Response("provider-private-token", { status: 429, headers: { "Retry-After": "300" } });
    if (!allowed && endpoint.includes(child)) return new Response("provider-private-token", { status: 404 });
    if (endpoint === "/v1/search") return Response.json({ results: [entity(outside), entity(root), entity(child)], has_more: false });
    if (endpoint === `/v1/databases/${database}` || endpoint === `/v1/data_sources/${database}`) return Response.json({ id: database, parent: { type: "page_id", page_id: root } });
    if (endpoint === `/v1/pages/${root}`) return Response.json(entity(root));
    if (endpoint === `/v1/pages/${child}`) return Response.json(entity(child));
    if (endpoint === `/v1/pages/${outside}`) return Response.json(entity(outside));
    if (endpoint === `/v1/pages/${subtree}`) return new Response("not a page", { status: 404 });
    if (endpoint === `/v1/blocks/${subtree}`) return Response.json({ id: subtree, parent: { type: "page_id", page_id: child } });
    if (endpoint === `/v1/pages/${child}/markdown` || endpoint === `/v1/pages/${root}/markdown`) return Response.json({ markdown, truncated: unknown.length > 0, unknown_block_ids: unknown });
    if (endpoint === `/v1/pages/${subtree}/markdown`) return Response.json({ markdown: "# 추가 구간\n\n불러온 하위 블록\n", truncated: false, unknown_block_ids: [] });
    throw new Error("unexpected_" + endpoint);
  } });
  return { service, calls, pauseCalls, edit: () => { edited = "2026-10-01T00:10:00Z"; markdown += "\n최신 수정\n"; }, revoke: () => { allowed = false; }, move: () => { underRoot = false; }, archive: () => { archived = true; }, database: () => { parentType = "database_id"; }, unknown: () => { unknown = [subtree]; markdown += `<unknown url="${subtree}"/>`; }, big: () => { markdown = "# 서버\n\n```text\n" + "긴 코드\n".repeat(300) + "```\n\n끝\n"; }, rateLimit: () => { retries = 1; } };
}

test("Notion URLs normalize to IDs and never become outbound destinations", () => {
  assert.equal(notionId(`https://app.notion.com/p/Framework-${root}?source=copy_link`), root);
  assert.equal(notionId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), root);
  assert.deepEqual(notionLinks(`https://evil.example/${root} https://app.notion.com/p/${root} https://notion.so/${root}`), [root]);
  for (const input of [`http://notion.so/${root}`, `https://notion.so.evil.example/${root}`, "../../secret", "not-a-page"]) assert.throws(() => notionId(input), NotionError);
});
test("reads original Markdown and preserves source identity, dates, and hash", async () => {
  const f = fixture(); const page = await f.service.read(child);
  assert.equal(page.title, "서버"); assert.match(page.content, /배포 절차/); assert.equal(page.content_hash.length, 64);
  assert.equal(page.url, `https://app.notion.com/p/${child}`); assert.equal(page.last_edited_time, "2026-10-01T00:00:00Z");
  assert.ok(!JSON.stringify(page).includes("secret-notion-token"));
});
test("rejects a page outside the configured root before reading its body", async () => {
  const f = fixture(); await assert.rejects(f.service.read(outside), (e: unknown) => e instanceof NotionError && e.code === "notion_outside_roots");
  assert.equal(f.calls.some((call) => call.endsWith(`${outside}/markdown`)), false);
});
test("walks database ancestry for database item pages", async () => {
  const f = fixture(); f.database(); assert.equal((await f.service.read(child)).id, child); assert.ok(f.calls.includes(`/v1/databases/${database}`));
});
test("cache hits still recheck permissions, ancestry, and page revision", async () => {
  const f = fixture(); await f.service.read(child); await f.service.read(child);
  assert.equal(f.calls.filter((call) => call === `/v1/pages/${child}/markdown`).length, 1);
  f.edit(); assert.match((await f.service.read(child)).content, /최신 수정/);
  assert.equal(f.calls.filter((call) => call === `/v1/pages/${child}/markdown`).length, 2);
  f.revoke(); await assert.rejects(f.service.read(child), (e: unknown) => e instanceof NotionError && e.code === "notion_not_accessible" && !e.message.includes("private"));
});
test("moving or archiving a cached page removes its read access", async () => {
  for (const change of ["move", "archive"] as const) { const f = fixture(); await f.service.read(child); f[change](); await assert.rejects(f.service.read(child), NotionError); }
});
test("title search excludes unrelated workspace pages", async () => {
  const f = fixture(); const result = await f.service.search("서버"); assert.deepEqual(result.results.map((page) => page.id), [root, child]);
});
test("retries rate limits with a bounded wait and redacts provider errors", async () => {
  const f = fixture(); f.rateLimit(); await f.service.read(child); assert.ok(f.pauseCalls.includes(5000));
  const service = new NotionService({ token: "key", rootIds: [root], intervalMs: 0, pause: async () => {}, fetchImpl: async () => new Response("private-token", { status: 401 }) });
  await assert.rejects(service.read(root), (e: unknown) => e instanceof NotionError && e.code === "notion_auth_failed" && !e.message.includes("private-token"));
});
test("keeps unknown subtrees separate without corrupting the cached page", async () => {
  const f = fixture(); f.unknown(); const first = await f.service.read(child); assert.equal(first.truncated, true);
  const extra = await f.service.readBounded(child, 10000, 0, subtree); assert.match(extra.content, /하위 블록/);
  assert.match((await f.service.read(child)).content, /배포 절차/);
  await assert.rejects(f.service.readBounded(child, 10000, 0, outside), (e: unknown) => e instanceof NotionError && e.code === "invalid_notion_subtree");
});
test("bounded reads preserve whole fenced code and expose a continuation", async () => {
  const f = fixture(); f.big(); const first = await f.service.readBounded(child, 1000);
  assert.ok(JSON.stringify(first).length <= 1000); assert.ok(first.content_truncated); assert.equal(first.content.includes("```"), false);
  const next = await f.service.readBounded(child, first.required_chars! + 100, first.next_block!, undefined, first.content_hash);
  assert.match(next.content, /```text[\s\S]+```/); assert.equal(next.content.startsWith("# 서버"), false);
  f.edit(); await assert.rejects(f.service.readBounded(child, 10000, first.next_block!, undefined, first.content_hash), (e: unknown) => e instanceof NotionError && e.code === "notion_stale_cursor");
});
test("mixed context keeps Notion URL citations, rechecks indexed sources, and reports incomplete reads", async () => {
  const f = fixture(); const index = new NotionIndex(f.service); await index.sync();
  const wiki = { getContext: async () => ({ evidence: [{ path: "서버.md", title: "서버", section_id: "서버:1", heading: "서버", content: "# 서버\n\nGit 위키 근거\n", hash: "wiki-hash", metadata: {} }] }) } as unknown as WikiService;
  const context = new SourceContext(wiki, f.service, index);
  const first = await context.getContext("배포 절차", { maxChars: 5000 });
  assert.ok(first.evidence.some((item) => item.source_type === "notion" && item.url === `https://app.notion.com/p/${child}`));
  assert.ok(first.evidence.some((item) => item.path === "서버.md")); assert.ok(JSON.stringify(first).length <= 5000);
  f.revoke(); const next = await context.getContext(`https://app.notion.com/p/${child}`);
  assert.equal(next.evidence.some((item) => item.path === `notion/${child}`), false);
  assert.ok(JSON.stringify(next.notices).includes("notion_not_accessible"));
});
test("a disabled Notion connection preserves existing Wiki retrieval", async () => {
  const notion = new NotionService(); const expected = { evidence: [], marker: "original" };
  const wiki = { getContext: async () => expected } as unknown as WikiService;
  const sources = new SourceContext(wiki, notion, new NotionIndex(notion));
  assert.equal(await sources.getContext("위키", { sources: "wiki" }), expected);
  const combined = await sources.getContext("위키");
  assert.deepEqual(combined.evidence, expected.evidence);
  assert.deepEqual(combined.notices, [{ source: "notion", code: "notion_unconfigured" }]);
  await assert.rejects(notion.search(""), (e: unknown) => e instanceof NotionError && e.code === "notion_unconfigured");
});
