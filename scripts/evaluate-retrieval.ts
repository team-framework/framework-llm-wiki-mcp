import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { z } from 'zod';
import { hashContent, parseSections } from '../src/sections.js';
import { WikiService, type Note, type ResolvedNote } from '../src/wiki.js';
import { WikiVectorIndex } from '../src/vector.js';

// Public code only. Queries, answer needles, source paths and payloads stay in private inputs.
const golden = z.array(z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), query: z.string().min(1).max(4000),
  includeHistory: z.boolean().optional(),
  expected: z.array(z.object({ path: z.string().min(1), needle: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1).optional(), needles: z.array(z.string().min(1)).min(1).optional()
  }).strict()).min(1)
}).strict()).min(1).max(1000);
type Gold = z.infer<typeof golden>[number];
type Source = { path: string; content: string };
type Row = { id: string; mode: string; score: boolean[]; tokens: number; latency_ms: number;
  truncated: boolean; evidence_count: number; retrieval: unknown };
const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const option = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const git = (directory: string, args: string[]) => { try { return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const score = (item: Gold, sources: Source[]) => item.expected.map(expected => sources.some(source =>
  (expected.paths ?? [expected.path]).includes(source.path) && (expected.needles ?? [expected.needle]).some(needle => source.content.includes(needle))));
const legacyNote = (note: ResolvedNote) => ({ path: note.path, title: note.title, content: note.content,
  body: note.body, metadata: note.metadata, links: note.links, resolved_links: note.resolved_links });

// Frozen fa57270 search scoring and summary format; this protocol uses five results and three reads.
function legacySearch(notes: Note[], item: Gold) {
  const query = item.query.trim().toLocaleLowerCase(), terms = query.split(/\s+/).filter(Boolean);
  return notes.filter(note => item.includeHistory || !note.path.split('/').includes('사건기록')).map(note => {
    const title = note.title.toLocaleLowerCase(), question = String(note.metadata.question ?? '').toLocaleLowerCase();
    const body = note.body.toLocaleLowerCase(), filename = note.path.toLocaleLowerCase();
    let value = (title.includes(query) ? 12 : 0) + (question.includes(query) ? 10 : 0) + (filename.includes(query) ? 8 : 0) + (body.includes(query) ? 4 : 0);
    for (const term of terms) value += (title.includes(term) ? 4 : 0) + (question.includes(term) ? 3 : 0) + (filename.includes(term) ? 2 : 0) + (body.includes(term) ? 1 : 0);
    return { note, value };
  }).filter(row => row.value > 0).sort((a, b) => b.value - a.value || a.note.path.localeCompare(b.note.path, 'ko')).slice(0, 5)
    .map(({ note, value }) => ({ path: note.path, title: note.title, question: note.metadata.question ?? null,
      domain: note.metadata.domain ?? null, owner: note.metadata.owner ?? null, verification: note.metadata.verification ?? null,
      last_verified: note.metadata.last_verified ?? null, score: value,
      excerpt: note.body.replace(/^#.+$/m, '').replace(/\s+/g, ' ').trim().slice(0, 280) }));
}

async function privateWrite(filename: string, value: unknown) {
  const parent = await fs.realpath(path.dirname(path.resolve(filename)));
  const relative = path.relative(await fs.realpath(repo), parent);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('private_output_in_repository');
  const file = await fs.open(path.join(parent, path.basename(filename)), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await file.chmod(0o600); await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); } finally { await file.close(); }
}

async function main() {
  const root = option('--root'), goldFile = option('--gold'), output = option('--output');
  if (!root || !goldFile || !output) throw new Error('required_arguments');
  const qdrantUrl = option('--qdrant-url'), embeddingUrl = option('--embedding-url');
  if (Boolean(qdrantUrl) !== Boolean(embeddingUrl)) throw new Error('both_vector_urls_required');
  const declaredCommit = option('--corpus-commit');
  if (declaredCommit && !/^[a-f0-9]{40}$/.test(declaredCommit)) throw new Error('invalid_commit');
  if ([output, option('--private-output')].some(filename => filename && path.resolve(filename) === path.resolve(goldFile))) throw new Error('output_overwrites_gold');
  if (option('--private-output') && path.resolve(option('--private-output')!) === path.resolve(output)) throw new Error('output_paths_overlap');
  const sourceFiles = ['scripts/evaluate-retrieval.ts', 'src/wiki.ts', 'src/sections.ts', 'src/vector.ts'];
  const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name, hashContent(await fs.readFile(path.join(repo, name), 'utf8'))])));
  const codeHashes = await sourceHashes();
  const goldBytes = await fs.readFile(goldFile, 'utf8'), items = golden.parse(JSON.parse(goldBytes));
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('duplicate_ids');
  const wiki = new WikiService(root), notes = await wiki.listNotes();
  const manifest = () => notes.map(note => `${note.path}\0${note.note_hash}`).sort().join('\n');
  const corpusHash = hashContent(manifest());
  let pinnedCollection: string | null = null;
  const alias = option('--alias') ?? 'framework_wiki';
  const vectors = qdrantUrl && embeddingUrl ? new WikiVectorIndex(wiki, { qdrantUrl, embeddingUrl,
    cacheDir: '/tmp/wiki-evaluation-unused-cache', alias, fetchImpl: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (pinnedCollection && url.pathname === `/collections/${alias}/points/query`) url.pathname = `/collections/${encodeURIComponent(pinnedCollection)}/points/query`;
      return fetch(url, init);
    } }) : null;
  let vectorProvenance: Record<string, unknown> | null = null;
  if (vectors) {
    const { model, revision } = vectors.status(), schema = 'e5-small-480-overlap48-v1';
    const sections = notes.flatMap(note => parseSections(note.content).filter(section => section.content.trim()).map(section => ({
      path: note.path, section_id: section.section_id, hash: section.hash,
      input: `${note.title}\n${section.headings.join(' > ')}\n${section.content}`,
      domain: note.metadata.domain ?? null, owner: note.metadata.owner ?? null, verification: note.metadata.verification ?? null,
      history: note.path.split('/').includes('사건기록')
    }))).sort((a, b) => a.path.localeCompare(b.path) || a.section_id.localeCompare(b.section_id));
    const signature = hashContent(JSON.stringify({ model, revision, schema, sources: sections.map(section =>
      [section.path, section.section_id, section.hash, hashContent(section.input), section.domain, section.owner, section.verification, section.history]) }));
    const aliases = await vectors.request('/aliases');
    const collection = aliases.result.aliases.find((entry: any) => entry.alias_name === vectors.alias)?.collection_name;
    if (!collection) throw new Error('vector_alias_missing');
    const manifest = await vectors.request(`/collections/${encodeURIComponent(collection)}/points/00000000-0000-4000-8000-000000000001`);
    if (manifest.result?.payload?.signature !== signature || manifest.result?.payload?.schema !== schema || manifest.result?.payload?.revision !== revision) throw new Error('vector_corpus_mismatch');
    pinnedCollection = collection;
    vectorProvenance = { collection, signature, model, revision, schema, sections: sections.length, manifest_verified: true };
  }
  // Read an already-published generation. Evaluation never calls sync or mutates a vector collection.
  const rows: Row[] = [], privateRows: unknown[] = [];
  const measuredAt = new Date().toISOString();
  for (const item of items) {
    const started = performance.now(), found = legacySearch(notes, item);
    const full = await Promise.all(found.slice(0, 3).map(async hit => legacyNote(await wiki.getNote(hit.path))));
    const legacy = [found, ...full].map(value => JSON.stringify(value, null, 2)).join('\n');
    const legacyLatency = performance.now() - started;
    rows.push({ id: item.id, mode: 'legacy', score: score(item, full), tokens: countTokens(legacy), latency_ms: legacyLatency,
      truncated: false, evidence_count: full.length, retrieval: null });
    if (option('--private-output')) privateRows.push({ id: item.id, mode: 'legacy', payload: legacy });
    for (const mode of vectors ? ['lexical', 'hybrid'] : ['lexical']) {
      wiki.setSemanticSearch(mode === 'hybrid' ? (query, options) => vectors!.search(query, options) : async () => ({ hits: [], status: 'not_configured' }));
      const start = performance.now();
      const context = await wiki.getContext(item.query, { limit: 8, maxChars: 12000, includeHistory: item.includeHistory ?? false });
      const retrieval = 'retrieval' in context ? context.retrieval : null;
      // A reader has no local writer lifecycle; "starting" is valid only with the verified manifest above.
      if (mode === 'hybrid' && (!retrieval || retrieval.mode !== 'hybrid' || !['ready', 'starting'].includes(retrieval.semantic_status) || retrieval.stale_hits !== 0)) throw new Error('hybrid_not_ready');
      const latency = performance.now() - start, payload = JSON.stringify(context);
      rows.push({ id: item.id, mode, score: score(item, context.evidence), tokens: countTokens(payload), latency_ms: latency,
        truncated: context.truncated, evidence_count: context.evidence.length, retrieval });
      if (option('--private-output')) privateRows.push({ id: item.id, mode, payload });
    }
  }
  const finalNotes = await wiki.listNotes();
  if (hashContent(finalNotes.map(note => `${note.path}\0${note.note_hash}`).sort().join('\n')) !== corpusHash) throw new Error('corpus_changed_during_evaluation');
  if (JSON.stringify(await sourceHashes()) !== JSON.stringify(codeHashes)) throw new Error('code_changed_during_evaluation');
  if (vectors && vectors.status().collection !== vectorProvenance?.collection) throw new Error('vector_generation_changed');
  const baseline = rows.filter(row => row.mode === 'legacy').reduce((sum, row) => sum + row.tokens, 0);
  const summary = [...new Set(rows.map(row => row.mode))].map(mode => {
    const selected = rows.filter(row => row.mode === mode), tokens = selected.reduce((sum, row) => sum + row.tokens, 0);
    return { mode, questions: selected.length, facts_found: selected.reduce((sum, row) => sum + row.score.filter(Boolean).length, 0),
      facts_required: selected.reduce((sum, row) => sum + row.score.length, 0), complete_questions: selected.filter(row => row.score.every(Boolean)).length,
      payload_tokens: tokens, reduction_percent: baseline ? Number((100 * (1 - tokens / baseline)).toFixed(2)) : null,
      truncated_questions: selected.filter(row => row.truncated).length };
  });
  const require = createRequire(import.meta.url);
  const tokenizerVersion = JSON.parse(await fs.readFile(require.resolve('gpt-tokenizer/package.json'), 'utf8')).version;
  const report = { schema_version: 1, measured_at: measuredAt, completed_at: new Date().toISOString(),
    corpus: { git_commit: git(root, ['rev-parse', 'HEAD']), declared_commit: declaredCommit ?? null, content_manifest_sha256: corpusHash, notes: notes.length },
    code: { git_commit: git(repo, ['rev-parse', 'HEAD']), dirty: Boolean(git(repo, ['status', '--porcelain'])),
      file_sha256: codeHashes },
    gold_file_sha256: hashContent(goldBytes), node_version: process.version, vector: vectorProvenance,
    tokenizer: { name: 'o200k_base', package: 'gpt-tokenizer', version: tokenizerVersion },
    protocol: { legacy: 'fa57270 scoring; search limit5 + top3 full-note reads with content/body and pretty JSON; concatenate tool payloads with one newline',
      current: 'first context page only; limit8; maxChars12000; compact JSON; per-query includeHistory',
      scoring: 'each expected fact requires any allowed source path AND any allowed literal needle within the same returned source; case-sensitive',
      nondeterminism: 'opaque random next_cursor values can change tokenizer counts slightly between identical retrieval runs',
      timing: 'local service calls, cold and warm caches mixed; excludes token counting; not HTTP/provider latency',
      exclusions: ['prompts', 'final answers', 'continuation costs', 'embedding cost', 'provider billing'],
      vector_generation: vectors ? 'manifest-verified immutable collection queried directly; read-only adapter may report starting because no writer sync runs; actual mode/status/stale hits retained per row' : 'not configured' },
    summary, rows };
  if (option('--private-output')) await privateWrite(option('--private-output')!, { report, rows: privateRows });
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ summary, rows: rows.length })}\n`);
}

main().catch((error: unknown) => {
  const safeCodes = new Set(['required_arguments', 'both_vector_urls_required', 'invalid_commit', 'output_overwrites_gold',
    'output_paths_overlap', 'duplicate_ids', 'vector_alias_missing', 'vector_corpus_mismatch', 'hybrid_not_ready',
    'corpus_changed_during_evaluation', 'code_changed_during_evaluation', 'vector_generation_changed', 'private_output_in_repository']);
  const code = error instanceof Error && safeCodes.has(error.message) ? error.message : 'invalid_input_or_service_error';
  process.stderr.write(`Evaluation failed (${code}). No private error detail is printed.\n`); process.exitCode = 1;
});
