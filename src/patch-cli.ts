import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyLocalPatch, type WikiPatch } from "./patch.js";

function option(name: string) { const position = process.argv.indexOf(name); return position < 0 ? undefined : process.argv[position + 1]; }
export async function runPatchCli() {
  const root = option("--root"); const input = option("--input");
  if (!root || !input) throw new Error("Usage: wiki-patch --root <local-wiki-checkout> --input <patch.json> [--apply]. Dry-run is the default.");
  const request = JSON.parse(await fs.readFile(input, "utf8")) as WikiPatch;
  const result = await applyLocalPatch(root, request, { apply: process.argv.includes("--apply") });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPatchCli().catch((error: Error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
