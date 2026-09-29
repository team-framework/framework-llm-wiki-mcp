import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { applyLocalPatch } from "../src/patch.js";
import { hashContent, parseSections } from "../src/sections.js";
const exec = promisify(execFile);

test("local section patches dry-run, preserve neighboring bytes, and reject stale proposals", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "framework-patch-"));
  try {
    await exec("git", ["init", "--quiet", root]);
    const content = "---\r\nowner: team # keep comment\r\n---\r\n# 제목\r\n\r\n## 앞\r\n유지 1\r\n\r\n## 대상\r\n옛 결정\r\n\r\n## 뒤\r\n유지 2\r\n";
    await writeFile(path.join(root, "note.md"), content);
    const section = parseSections(content).find((section) => section.heading === "대상")!;
    const request = { path: "note.md", expected_note_hash: hashContent(content), operations: [{ section_id: section.section_id, expected_hash: section.hash, replacement: "## 대상\r\n새 결정\r\n\r\n" }] };
    const preview = await applyLocalPatch(root, request);
    assert.equal(preview.applied, false); assert.match(preview.diff, /새 결정/);
    assert.equal(await readFile(path.join(root, "note.md"), "utf8"), content);
    const applied = await applyLocalPatch(root, request, { apply: true });
    const actual = await readFile(path.join(root, "note.md"), "utf8");
    assert.equal(actual, content.slice(0, section.start) + request.operations[0].replacement + content.slice(section.end));
    assert.equal(applied.after_hash, hashContent(actual));
    await assert.rejects(applyLocalPatch(root, request, { apply: true }), /Stale note hash/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("section CAS rejects stale content even when callers omit the optional note hash", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "framework-section-cas-"));
  try {
    await exec("git", ["init", "--quiet", root]);
    const original = "# 제목\n\n## 대상\n이전 결정\n";
    await writeFile(path.join(root, "note.md"), original);
    const section = parseSections(original).find((section) => section.heading === "대상")!;
    await writeFile(path.join(root, "note.md"), original.replace("이전", "다른"));
    await assert.rejects(applyLocalPatch(root, { path: "note.md", operations: [{ section_id: section.section_id, expected_hash: section.hash, replacement: "## 대상\n새 결정\n" }] }, { apply: true }), /Stale section hash/);
    assert.ok((await readFile(path.join(root, "note.md"), "utf8")).includes("다른 결정"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("create patches prevent collisions and escapes and require a local Git checkout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "framework-create-"));
  const outside = await mkdtemp(path.join(tmpdir(), "framework-create-outside-"));
  try {
    await assert.rejects(applyLocalPatch(root, { path: "new.md", create: "# 새 문서\n" }), /Command failed/);
    await exec("git", ["init", "--quiet", root]);
    const request = { path: "docs/new.md", create: "# 새 문서\n\n## 결정\n승인 후 반영한다.\n" };
    assert.equal((await applyLocalPatch(root, request)).applied, false);
    await assert.rejects(readFile(path.join(root, "docs/new.md")), /ENOENT/);
    assert.equal((await applyLocalPatch(root, request, { apply: true })).applied, true);
    await assert.rejects(applyLocalPatch(root, request, { apply: true }), /Create collision/);
    await assert.rejects(applyLocalPatch(root, { path: "../escape.md", create: "# 탈출\n" }, { apply: true }), /Invalid wiki note path/);
    await symlink(outside, path.join(root, "outside"));
    await assert.rejects(applyLocalPatch(root, { path: "outside/escape.md", create: "# 탈출\n" }, { apply: true }), /Invalid wiki note path/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
