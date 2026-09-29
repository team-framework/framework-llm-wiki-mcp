import { execFile } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { hashContent, parseSections } from "./sections.js";
import { confinedNotePath } from "./wiki.js";

const execFileAsync = promisify(execFile);
export type SectionReplacement = { section_id: string; expected_hash: string; replacement: string };
export type WikiPatch = { path: string; expected_note_hash?: string; operations: SectionReplacement[]; create?: never }
  | { path: string; create: string; expected_note_hash?: never; operations?: never };
export type PatchPreview = {
  path: string; action: "create" | "replace"; before_hash: string | null; after_hash: string;
  changed_sections: string[]; before_chars: number; after_chars: number;
  diff: string; diff_truncated: boolean; applied: boolean;
};

function validateRequest(value: WikiPatch) {
  if (!value || typeof value !== "object" || typeof value.path !== "string") throw new Error("Invalid wiki patch.");
  if (typeof value.create === "string") {
    if (!value.create.trim() || value.operations !== undefined || value.expected_note_hash !== undefined) throw new Error("Create patches require only path and non-empty create content.");
  } else if (!Array.isArray(value.operations) || !value.operations.length || value.operations.length > 64
    || value.operations.some((op) => !op || typeof op.section_id !== "string" || !/^[a-f0-9]{64}$/.test(op.expected_hash) || typeof op.replacement !== "string")
    || new Set(value.operations.map((op) => op.section_id)).size !== value.operations.length
    || (value.expected_note_hash !== undefined && !/^[a-f0-9]{64}$/.test(value.expected_note_hash))) throw new Error("Invalid section replacement patch.");
}

async function localCheckout(root: string) {
  const realRoot = await fs.realpath(root);
  const { stdout } = await execFileAsync("git", ["-C", realRoot, "rev-parse", "--show-toplevel"]);
  if (await fs.realpath(stdout.trim()) !== realRoot) throw new Error("Patch root must be a local Git checkout root.");
  await fs.access(realRoot, constants.W_OK);
  return realRoot;
}

async function noSymlinkComponents(root: string, target: string) {
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Patch paths cannot contain symlinks."); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

function compactDiff(before: string, after: string, maxChars = 2_000) {
  const oldLines = before.split("\n"); const newLines = after.split("\n");
  let prefix = 0; let suffix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines.at(-suffix - 1) === newLines.at(-suffix - 1)) suffix++;
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const diff = [`@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`, ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join("\n");
  return { diff: diff.slice(0, maxChars), diff_truncated: diff.length > maxChars };
}

async function prepare(root: string, request: WikiPatch) {
  validateRequest(request);
  const full = await confinedNotePath(root, request.path, "create" in request);
  await noSymlinkComponents(root, full);
  let before = ""; let mode = 0o644;
  try {
    const stat = await fs.stat(full);
    if (!stat.isFile()) throw new Error("Patch target must be a Markdown file.");
    mode = stat.mode & 0o777;
    before = await fs.readFile(full, "utf8");
    if ("create" in request) throw new Error("Create collision: wiki note already exists.");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !("create" in request)) throw error;
  }
  const beforeHash = "create" in request ? null : hashContent(before);
  let after: string;
  let changed: string[];
  if (typeof request.create === "string") { after = request.create; changed = ["create"]; }
  else {
    if (request.expected_note_hash && beforeHash !== request.expected_note_hash) throw new Error("Stale note hash: the wiki note changed after the proposal.");
    const sections = parseSections(before);
    const replacements = request.operations.map((operation) => {
      const section = sections.find((section) => section.section_id === operation.section_id);
      if (!section) throw new Error(`Wiki section not found: ${operation.section_id}`);
      if (section.hash !== operation.expected_hash) throw new Error(`Stale section hash: ${operation.section_id}`);
      return { section, operation };
    }).sort((a, b) => b.section.start - a.section.start);
    after = before;
    for (const { section, operation } of replacements) after = after.slice(0, section.start) + operation.replacement + after.slice(section.end);
    changed = request.operations.map((operation) => operation.section_id);
  }
  // Parsing the final note validates YAML while preserving its original bytes for replacement patches.
  parseSections(after);
  const preview: PatchPreview = { path: request.path, action: beforeHash === null ? "create" : "replace", before_hash: beforeHash,
    after_hash: hashContent(after), changed_sections: changed, before_chars: before.length, after_chars: after.length,
    ...compactDiff(before, after), applied: false };
  return { full, before, after, mode, preview };
}

/** This API is deliberately not registered as an MCP tool or exposed by the wiki HTTP reader. */
export async function applyLocalPatch(root: string, request: WikiPatch, options: { apply?: boolean } = {}): Promise<PatchPreview> {
  const realRoot = await localCheckout(root);
  if (!options.apply) return (await prepare(realRoot, request)).preview;
  const { stdout } = await execFileAsync("git", ["-C", realRoot, "rev-parse", "--git-path", "framework-wiki-patch.lock"]);
  const lockPath = path.resolve(realRoot, stdout.trim());
  let lock;
  try { lock = await fs.open(lockPath, "wx", 0o600); }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another local wiki patch is in progress. Inspect the lock before retrying."); throw error; }
  let temporary: string | undefined;
  try {
    const plan = await prepare(realRoot, request);
    await fs.mkdir(path.dirname(plan.full), { recursive: true });
    await confinedNotePath(realRoot, request.path, plan.preview.action === "create");
    await noSymlinkComponents(realRoot, plan.full);
    temporary = `${plan.full}.wiki-patch-${process.pid}-${Date.now()}.tmp`;
    const handle = await fs.open(temporary, "wx", plan.mode);
    try { await handle.writeFile(plan.after, "utf8"); await handle.sync(); } finally { await handle.close(); }
    if (plan.preview.action === "create") {
      // Hard-link with exclusive creation avoids replacing a concurrently created note.
      await fs.link(temporary, plan.full);
      await fs.unlink(temporary); temporary = undefined;
    } else {
      await noSymlinkComponents(realRoot, plan.full);
      if (hashContent(await fs.readFile(plan.full, "utf8")) !== plan.preview.before_hash) throw new Error("Stale note hash: wiki changed while applying the patch.");
      await fs.rename(temporary, plan.full); temporary = undefined;
    }
    return { ...plan.preview, applied: true };
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => {});
    await lock.close(); await fs.unlink(lockPath);
  }
}
