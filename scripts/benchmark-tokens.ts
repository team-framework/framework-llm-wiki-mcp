import { promises as fs } from "node:fs";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { hashContent, parseSections } from "../src/sections.js";
import { WikiService, type Note, type ResolvedNote } from "../src/wiki.js";
import { WikiVectorIndex } from "../src/vector.js";

const queries = ["WebRTC 연결", "JWT 인증", "GPU 운영", "CI/CD 배포", "성능 평가", "권한 설정", "장애 복구", "API 계약"];
function option(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
function tokens(value: unknown, pretty = false) { return countTokens(typeof value === "string" ? value : JSON.stringify(value, null, pretty ? 2 : undefined)); }
function legacyNote(note: ResolvedNote) { const { note_hash: _newHash, ...old } = note; return old; }
function legacySearch(notes: Note[], query: string) {
  const normalized = query.toLocaleLowerCase(); const terms = normalized.split(/\s+/).filter(Boolean);
  return notes.filter((note) => !note.path.split("/").includes("사건기록")).map((note) => {
    const title = note.title.toLocaleLowerCase(); const question = String(note.metadata.question ?? "").toLocaleLowerCase();
    const body = note.body.toLocaleLowerCase(); const filePath = note.path.toLocaleLowerCase();
    let score = (title.includes(normalized) ? 12 : 0) + (question.includes(normalized) ? 10 : 0) + (filePath.includes(normalized) ? 8 : 0) + (body.includes(normalized) ? 4 : 0);
    for (const term of terms) score += (title.includes(term) ? 4 : 0) + (question.includes(term) ? 3 : 0) + (filePath.includes(term) ? 2 : 0) + (body.includes(term) ? 1 : 0);
    return { note, score };
  }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.note.path.localeCompare(b.note.path, "ko")).slice(0, 10).map(({ note, score }) => ({
    path: note.path, title: note.title, question: note.metadata.question ?? null, domain: note.metadata.domain ?? null,
    owner: note.metadata.owner ?? null, verification: note.metadata.verification ?? null, last_verified: note.metadata.last_verified ?? null,
    score, excerpt: note.body.replace(/^#.+$/m, "").replace(/\s+/g, " ").trim().slice(0, 280)
  }));
}
function aggregate(rows: Array<{ before_tokens: number; after_tokens: number }>) {
  const before = rows.reduce((sum, row) => sum + row.before_tokens, 0);
  const after = rows.reduce((sum, row) => sum + row.after_tokens, 0);
  const percentages = rows.map((row) => 100 * (1 - row.after_tokens / row.before_tokens)).sort((a, b) => a - b);
  return { samples: rows.length, before_tokens: before, after_tokens: after,
    reduction_percent: before ? Number((100 * (1 - after / before)).toFixed(2)) : null,
    median_reduction_percent: percentages.length ? Number(percentages[Math.floor(percentages.length / 2)].toFixed(2)) : null };
}

const root = option("--root");
if (!root) throw new Error("Usage: benchmark-tokens --root <corpus-directory> [--output <report.json>] [--commit <source-commit>] [--qdrant-url <url> --embedding-url <url>]");
const wiki = new WikiService(root);
const qdrantUrl = option("--qdrant-url"); const embeddingUrl = option("--embedding-url");
if (qdrantUrl && embeddingUrl) {
  // Read the existing published vector generation. This benchmark never rebuilds an index.
  const vectors = new WikiVectorIndex(wiki, { qdrantUrl, embeddingUrl, cacheDir: "/tmp/framework-benchmark-unused", alias: option("--alias") });
  wiki.setSemanticSearch((query, options) => vectors.search(query, options));
}
const notes = await wiki.listNotes();
const readRows = [];
for (const [index, query] of queries.entries()) {
  const search = legacySearch(notes, query);
  const fullNotes = await Promise.all(search.slice(0, 3).map(async (hit) => legacyNote(await wiki.getNote(hit.path))));
  const beforeTokens = tokens(search, true) + fullNotes.reduce((sum, note) => sum + tokens(note, true), 0);
  const context = await wiki.getContext(query, { maxChars: 12_000, limit: 8 });
  readRows.push({ task: index + 1, query, before_tokens: beforeTokens, after_tokens: tokens(context),
    baseline_full_notes: fullNotes.length, evidence_sections: context.evidence.length,
    evidence_chars: context.evidence_chars, truncated: context.truncated, retrieval: context.retrieval,
    reduction_percent: beforeTokens ? Number((100 * (1 - tokens(context) / beforeTokens)).toFixed(2)) : null });
}

// Paired source tests isolate format savings from ranking quality: same note and exact target section.
const writeRows = [];
for (const note of notes.filter((note) => !note.path.split("/").includes("사건기록")).sort((a, b) => b.content.length - a.content.length)) {
  const sections = parseSections(note.content);
  const eligible = sections.filter((section) => section.level >= 2 && section.content.length >= 120);
  if (eligible.length < 3) continue;
  const target = eligible[Math.floor(eligible.length / 2)];
  const replacement = `${target.content.trimEnd()}\n\n추가 확인: 사람이 최종 결론을 승인한 뒤 반영한다.\n\n`;
  const updated = note.content.slice(0, target.start) + replacement + note.content.slice(target.end);
  const source = legacyNote(await wiki.getNote(note.path));
  const outline = await wiki.getOutline(note.path);
  const read = await wiki.readSections([{ path: note.path, section_id: target.section_id, hash: target.hash }], { maxChars: 128_000 });
  const patch = { path: note.path, expected_note_hash: note.note_hash, operations: [{ section_id: target.section_id, expected_hash: target.hash, replacement }] };
  writeRows.push({ task: writeRows.length + 1, note_chars: note.content.length, target_section_chars: target.content.length,
    before_tokens: tokens(source, true) + tokens(updated), after_tokens: tokens(outline) + tokens(read) + tokens(patch),
    read_truncated: read.truncated, unchanged_chars: note.content.length - target.content.length });
  if (writeRows.length === 20) break;
}
const creationRows = notes.slice(0, 20).map((note, index) => ({ task: index + 1, before_tokens: tokens(note.content), after_tokens: tokens({ path: note.path, create: note.content }) }));
const report = {
  measured_at: new Date().toISOString(), corpus_commit: option("--commit") ?? null, note_count: notes.length,
  corpus_hash: hashContent(notes.map((note) => `${note.path}\0${note.note_hash}`).sort().join("\n")), tokenizer: "o200k_base",
  scope: "Local tokenizer counts of tool payloads and generated Markdown/patch text; excludes prompts, model reasoning, billing, embeddings and network latency.",
  read_scenario: "Fixed 8 topic queries. Legacy search_wiki (10 results) plus read_note for first 3 full notes with duplicated content/body and pretty JSON; new get_context (8 sections, 12000 evidence JSON chars). Ranking differs; semantic relevance has no human ground-truth in this measurement.",
  write_scenario: "First 20 largest current notes with at least 3 substantive sections. Same-source synthetic one-section amendment: legacy full note read plus regenerated Markdown versus outline + exact section read + CAS patch. No corpus files are changed.",
  creation_scenario: "Creating new knowledge still requires the complete new Markdown text. The create request adds small protocol overhead; retrieval savings are measured separately.",
  reads: { ...aggregate(readRows), tasks: readRows }, updates: { ...aggregate(writeRows), tasks: writeRows }, creations: aggregate(creationRows)
};
if (option("--output")) await fs.writeFile(option("--output")!, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(report)}\n`);
