import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WikiService } from "../src/wiki.js";

// Deliberately synthetic documents: real team sources and benchmark responses stay private.
async function corpus(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-ranking-test-"));
  for (const [relative, content] of Object.entries(files)) {
    const filename = path.join(root, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, content);
  }
  return { root, wiki: new WikiService(root), close: () => rm(root, { recursive: true, force: true }) };
}

test("a direct passage outranks unrelated sections whose document question matches", async () => {
  const f = await corpus({
    "handbook.md": "---\nquestion: token retention expiration\n---\n# Handbook\nIntroduction.\n\n"
      + Array.from({ length: 8 }, (_, i) => `## Appendix ${i}\nUnrelated equipment inventory.\n\n`).join(""),
    "answer.md": "# Runtime\nToken retention expiration is enforced after seven minutes.\n",
  });
  try {
    const result = await f.wiki.getContext("token retention expiration", { limit: 2, maxChars: 10_000 });
    assert.equal(result.evidence[0]?.path, "answer.md");
    assert.match(result.evidence[0].content, /seven minutes/);
  } finally { await f.close(); }
});

test("the first context page retains another relevant document when one manual has many matches", async () => {
  const f = await corpus({
    "manual.md": "# Manual\n\n" + Array.from({ length: 6 }, (_, i) => `## Recovery ${i}\nRecovery details for component ${i}.\n\n`).join(""),
    "operator.md": "# Operator\nRecovery requires a separate operator confirmation.\n",
  });
  try {
    const result = await f.wiki.getContext("recovery", { limit: 3, maxChars: 10_000 });
    assert.ok(result.evidence.some((item) => item.path === "operator.md" && item.content.includes("operator confirmation")));
    assert.equal(result.evidence.filter((item) => item.path === "manual.md").length, 2);
  } finally { await f.close(); }
});

test("document diversity does not discard additional matches when only one document is relevant", async () => {
  const f = await corpus({
    "manual.md": "# Manual\n\n" + Array.from({ length: 4 }, (_, i) => `## Recovery ${i}\nRequired recovery step ${i}.\n\n`).join(""),
  });
  try {
    const result = await f.wiki.getContext("recovery", { limit: 4, maxChars: 10_000 });
    assert.equal(result.evidence.length, 4);
    for (let i = 0; i < 4; i++) assert.ok(result.evidence.some((item) => item.content.includes(`Required recovery step ${i}.`)));
  } finally { await f.close(); }
});

test("current identifier queries prioritize only the root metrics singleton", async () => {
  const f = await corpus({
    "_현행_수치.md": "# Recorded values\n\n## Capacity\nBATCH_LIMIT is currently seven.\n",
    "copies/_현행_수치.md": "# BATCH_LIMIT copy\nAn unrelated copied BATCH_LIMIT is ninety. WORKER_LIMIT is also mentioned.\n",
    "history.md": "# BATCH_LIMIT BATCH_LIMIT\nBATCH_LIMIT once used an older default.\n",
    "workers.md": "# WORKER_LIMIT\nThe worker limit has its dedicated reference here.\n",
  });
  try {
    const result = await f.wiki.getContext("BATCH_LIMIT current value", { limit: 2, maxChars: 10_000 });
    assert.equal(result.evidence[0]?.path, "_현행_수치.md");
    assert.match(result.evidence[0].content, /currently seven/);
    // A same-named file below another directory has no canonical-source privilege.
    const worker = await f.wiki.getContext("WORKER_LIMIT", { limit: 1 });
    assert.equal(worker.evidence[0]?.path, "workers.md");
  } finally { await f.close(); }
});

test("historical questions and domain restrictions are not overridden by current metrics priority", async () => {
  const f = await corpus({
    "_현행_수치.md": "---\ndomain: server\n---\n# Values\nBATCH_LIMIT is seven.\n",
    "사건기록/old.md": "---\ndomain: client\n---\n# BATCH_LIMIT 과거\nThe old BATCH_LIMIT was three.\n",
  });
  try {
    const historical = await f.wiki.getContext("BATCH_LIMIT 과거", { includeHistory: true, limit: 1 });
    assert.equal(historical.evidence[0]?.path, "사건기록/old.md");
    const restricted = await f.wiki.getContext("BATCH_LIMIT", { domain: "client", includeHistory: true });
    assert.ok(restricted.evidence.length > 0);
    assert.ok(restricted.evidence.every((item) => item.path === "사건기록/old.md"));
    const currentOnly = await f.wiki.getContext("BATCH_LIMIT", { domain: "client" });
    assert.equal(currentOnly.evidence.length, 0);
  } finally { await f.close(); }
});

test("stale semantic hits cannot replace current source evidence", async () => {
  const f = await corpus({ "answer.md": "# Capacity\nThe current quota is seven.\n" });
  try {
    const outline = await f.wiki.getOutline("answer.md");
    const old = outline.sections[0];
    f.wiki.setSemanticSearch(async () => ({ status: "ready", hits: [
      { path: "answer.md", section_id: old.section_id, hash: old.hash, score: 0.99 },
    ] }));
    await writeFile(path.join(f.root, "answer.md"), "# Capacity\nThe current quota is eleven after revision.\n");
    const result = await f.wiki.getContext("quota");
    assert.equal(result.retrieval?.stale_hits, 1);
    assert.equal(result.retrieval?.mode, "lexical");
    assert.match(result.evidence[0]?.content ?? "", /eleven after revision/);
    assert.ok(result.evidence.every((item) => !item.content.includes("seven")));
  } finally { await f.close(); }
});

test("opaque continuation stays small and reconstructs a long source without omissions", async () => {
  const source = "# Recovery\n\n" + Array.from({ length: 18 }, (_, i) => `Step ${i}: recover ${"carefully ".repeat(10)}.\n\n`).join("");
  const f = await corpus({ "long.md": source });
  try {
    const first = await f.wiki.getContext("recovery", { limit: 1, maxChars: 1_200 });
    assert.equal(first.truncated, true);
    assert.ok(first.next_cursor && first.next_cursor.length <= 64);
    assert.ok(!first.next_cursor.includes("long.md"));
    const content = first.evidence.map((item) => item.content);
    let cursor = first.next_cursor;
    let pages = 0;
    while (cursor) {
      assert.ok(++pages < 40, "continuation must make progress");
      const next = await f.wiki.readSections([], { cursor, maxChars: 1_200 });
      content.push(...next.evidence.map((item) => item.content));
      cursor = next.next_cursor;
    }
    assert.equal(content.join(""), source);
    await assert.rejects(new WikiService(f.root).readSections([], { cursor: first.next_cursor! }), /Invalid section cursor/);
    await writeFile(path.join(f.root, "long.md"), source + "A new decision.\n");
    await assert.rejects(f.wiki.readSections([], { cursor: first.next_cursor! }), /Stale section hash/);
  } finally { await f.close(); }
});
