import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { compactNote } from "../src/mcp.js";
import { parseSections, sectionBlocks, termFrequency } from "../src/sections.js";
import { WikiService } from "../src/wiki.js";

test("outline ignores YAML and fenced headings and distinguishes duplicate and setext headings", () => {
  const markdown = "---\nquestion: '# not a heading'\n---\n# 실제 제목\n\n## 반복\n첫 문단\n\n```md\n## 코드 내부\n```\n\n## 반복\n둘째 문단\n\nSetext\n======\n끝\n";
  const sections = parseSections(markdown);
  assert.deepEqual(sections.map((section) => section.heading), ["실제 제목", "반복", "반복", "Setext"]);
  assert.equal(new Set(sections.map((section) => section.section_id)).size, 4);
  assert.ok(sections[1].content.includes("## 코드 내부"));
  assert.equal(sections[0].start_line, 4);
  assert.equal(sections.map((section) => section.content).join(""), markdown.slice(markdown.indexOf("# 실제 제목")));
});

test("a table and fenced code with blank lines remain complete Markdown blocks", () => {
  const code = "```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n";
  const table = "| 이름 | 값 |\n| --- | --- |\n| 가 | 1 |\n| 나 | 2 |\n\n";
  const blocks = sectionBlocks(`## 내용\n\n${table}${code}끝\n`);
  assert.ok(blocks.some((block) => block.content === table));
  assert.ok(blocks.some((block) => block.content === code));
});

test("Korean short substrings rank relevant sections and identifiers do not match longer names", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "framework-sections-"));
  try {
    await writeFile(path.join(root, "relevant.md"), "# 운영\n\n## 권한 설정\n권한을 확인한 뒤 배포한다.\n\n## 구현\ngetNote()로 문서를 읽는다.\n");
    await writeFile(path.join(root, "other.md"), "# 구현 상세\n\n## 다른 함수\ngetNoteExtended()와 authorization 설정이다.\n");
    const wiki = new WikiService(root);
    const korean = await wiki.getContext("권한", { maxChars: 4_000 });
    assert.equal(korean.evidence[0].heading, "권한 설정");
    assert.ok(korean.evidence[0].content.includes("권한을 확인"));
    const exact = await wiki.search("getNote");
    assert.deepEqual(exact.map((hit) => hit.path), ["relevant.md"]);
    assert.equal(termFrequency("getNoteExtended()", "getnote"), 0);
    assert.equal(exact[0].sections[0].heading, "구현");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bounded reads continue losslessly and stale continuations cannot read changed sources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "framework-continuation-"));
  try {
    const content = `# 제목\n\n## 내용\n\n${Array.from({ length: 8 }, (_, index) => `문단 ${index}: ${"자료 ".repeat(70)}\n\n`).join("")}`;
    await writeFile(path.join(root, "note.md"), content);
    const wiki = new WikiService(root);
    const outline = await wiki.getOutline("note.md");
    const section = outline.sections.find((entry) => entry.heading === "내용")!;
    const first = await wiki.readSections([{ path: "note.md", section_id: section.section_id, hash: section.hash }], { maxChars: 1_250 });
    assert.ok(first.truncated); assert.ok(first.next_cursor); assert.ok(first.evidence_chars <= 1_250);
    let read = first.evidence.map((item) => item.content).join(""); let cursor = first.next_cursor;
    let pages = 0;
    while (cursor) {
      const page = await wiki.readSections([], { maxChars: 1_250, cursor });
      assert.ok(page.evidence_chars <= 1_250);
      read += page.evidence.map((item) => item.content).join(""); cursor = page.next_cursor;
      assert.ok(++pages < 15);
    }
    assert.equal(read, parseSections(content).find((entry) => entry.heading === "내용")!.content);
    await writeFile(path.join(root, "note.md"), content.replace("문단 7", "변경 7"));
    await assert.rejects(wiki.readSections([], { cursor: first.next_cursor! }), /Stale section hash/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("oversized fenced blocks report a larger budget and are returned whole on continuation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "framework-fence-"));
  try {
    const code = `\n\n\`\`\`ts\n${"const value = 123;\n".repeat(150)}\`\`\`\n`;
    await writeFile(path.join(root, "note.md"), `# 제목\n\n## 코드${code}`);
    const wiki = new WikiService(root); const outline = await wiki.getOutline("note.md");
    const codeSection = outline.sections.find((section) => section.heading === "코드")!;
    const first = await wiki.readSections([{ path: "note.md", section_id: codeSection.section_id }], { maxChars: 1_000 });
    assert.ok(first.truncated); assert.ok(first.required_chars! > 1_000);
    assert.ok(!first.evidence.some((item) => item.content.includes("```")));
    const continuation = await wiki.readSections([], { cursor: first.next_cursor!, maxChars: first.required_chars! + 20 });
    assert.ok(!continuation.truncated);
    assert.ok(continuation.evidence[0].content.includes("const value = 123;"));
    assert.equal(continuation.evidence[0].content.match(/```/g)?.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("realpath confinement rejects both traversal and symlink escapes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "framework-confined-"));
  const outside = await mkdtemp(path.join(tmpdir(), "framework-outside-"));
  try {
    await writeFile(path.join(outside, "secret.md"), "# outside\n");
    await symlink(path.join(outside, "secret.md"), path.join(root, "link.md"));
    await symlink(outside, path.join(root, "escape"));
    const wiki = new WikiService(root);
    await assert.rejects(wiki.getNote("../secret.md"), /Invalid wiki note path/);
    await assert.rejects(wiki.getNote("link.md"), /Invalid wiki note path/);
    await assert.rejects(wiki.getNote("escape/secret.md"), /Invalid wiki note path/);
    assert.equal((await wiki.listNotes()).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("cached search reflects external edits, additions and deletion without duplicating note bodies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "framework-cache-"));
  try {
    await writeFile(path.join(root, "note.md"), "# 기록\n첫번째 값\n");
    const wiki = new WikiService(root); const original = await wiki.getNote("note.md");
    await writeFile(path.join(root, "note.md"), "# 기록\n외부 수정\n");
    const updated = await wiki.getNote("note.md");
    assert.notEqual(updated.note_hash, original.note_hash);
    assert.ok((await wiki.search("외부"))[0].excerpt.includes("외부 수정"));
    await writeFile(path.join(root, "new.md"), "# 새 자료\n추가 문서\n");
    assert.equal((await wiki.status()).note_count, 2);
    await rm(path.join(root, "note.md"));
    assert.equal((await wiki.status()).note_count, 1);
    const compact = compactNote(await wiki.getNote("new.md"));
    assert.ok(!("body" in compact)); assert.equal(compact.content, await readFile(path.join(root, "new.md"), "utf8"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("hybrid search uses fresh semantic hits, filters stale hashes and reports fallback", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "framework-hybrid-"));
  try {
    await writeFile(path.join(root, "first.md"), "# 연결\n\n## 유효 시간\n토큰은 일정 시간이 지나면 만료한다.\n");
    await writeFile(path.join(root, "second.md"), "# 인증\n\n## 수명\n세션 종료 뒤 다시 로그인한다.\n");
    const wiki = new WikiService(root);
    const outline = await wiki.getOutline("second.md"); const section = outline.sections.find((section) => section.heading === "수명")!;
    wiki.setSemanticSearch(async () => ({ status: "ready", hits: [
      { path: "second.md", section_id: section.section_id, hash: section.hash, score: 0.95 },
      { path: "first.md", section_id: "bad", hash: "stale", score: 0.8 }
    ] }));
    const search = await wiki.search("credential expiry");
    assert.equal(search[0].path, "second.md"); assert.equal(search[0].retrieval.mode, "hybrid");
    const context = await wiki.getContext("credential expiry");
    assert.equal(context.evidence[0].heading, "수명"); assert.equal(context.retrieval?.stale_hits, 1);
    wiki.setSemanticSearch(async () => { throw new Error("unavailable"); });
    const fallback = await wiki.getContext("토큰");
    assert.equal(fallback.retrieval?.mode, "lexical"); assert.equal(fallback.retrieval?.semantic_status, "unavailable");
    assert.ok(fallback.evidence.some((item) => item.content.includes("토큰")));
  } finally { await rm(root, { recursive: true, force: true }); }
});
