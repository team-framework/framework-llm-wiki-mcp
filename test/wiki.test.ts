import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WikiService } from "../src/wiki.js";

test("searches current notes, filters array domains, and excludes incident history by default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "framework-wiki-"));
  try {
    await mkdir(path.join(root, "사건기록"));
    await writeFile(path.join(root, "current.md"), "---\ndomain:\n  - client\nowner: client-team\nverification: verified\n---\n# WebRTC 연결\n현재 연결 절차입니다.\n");
    await writeFile(path.join(root, "사건기록", "old.md"), "---\ndomain: client\n---\n# WebRTC 장애\n과거 장애입니다.\n");
    const wiki = new WikiService(root);
    const current = await wiki.search("WebRTC", { domain: "client" });
    assert.equal(current.length, 1);
    assert.equal(current[0].path, "current.md");
    const includingHistory = await wiki.search("WebRTC", { domain: "client", includeHistory: true });
    assert.equal(includingHistory.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
