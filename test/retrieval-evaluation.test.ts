import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile), repo = fileURLToPath(new URL('..', import.meta.url));
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'retrieval-evaluation-'));
  const source = 'private-source-title.md', marker = 'PRIVATE_SENTENCE_47c0da';
  await writeFile(path.join(directory, source), `# Synthetic\n\n## Policy\n${marker} is the verified policy.\n`);
  const gold = path.join(directory, 'gold.json'), output = path.join(directory, 'aggregate.json');
  await writeFile(gold, JSON.stringify([{ id: 'q1', query: marker, expected: [{ path: source, needle: marker }] }]));
  const run = (extra: string[] = []) => exec(process.execPath, ['--import', 'tsx', 'scripts/evaluate-retrieval.ts',
    '--root', directory, '--gold', gold, '--output', output, ...extra], { cwd: repo });
  return { directory, source, marker, output, run, close: () => rm(directory, { recursive: true, force: true }) };
}

test('replay finds synthetic evidence while public report and stdout omit private sources', async () => {
  const f = await fixture();
  try {
    const privateFile = path.join(f.directory, 'private.json');
    const { stdout, stderr } = await f.run(['--private-output', privateFile]);
    const reportText = await readFile(f.output, 'utf8'), report = JSON.parse(reportText);
    for (const value of [reportText, stdout, stderr]) {
      assert.equal(value.includes(f.marker), false); assert.equal(value.includes(f.source), false);
    }
    assert.deepEqual(report.rows.map((row: any) => row.score), [[true], [true]]);
    assert.equal(report.summary[0].questions, 1);
    assert.equal(report.corpus.notes, 1);
    assert.match(report.corpus.content_manifest_sha256, /^[a-f0-9]{64}$/);
    assert.ok(report.tokenizer.version);
    assert.equal((await stat(privateFile)).mode & 0o777, 0o600);
    assert.ok((await readFile(privateFile, 'utf8')).includes(f.marker));
  } finally { await f.close(); }
});

test('private payload output inside the repository is rejected without exposing error details', async () => {
  const f = await fixture(), forbidden = path.join(repo, 'retrieval-test-private-forbidden.json');
  try {
    await assert.rejects(f.run(['--private-output', forbidden]), (error: any) => {
      assert.equal(error.stdout, ''); assert.equal(error.stderr.includes(f.marker), false); return true;
    });
    await assert.rejects(stat(forbidden), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('a vector index from a different corpus fails before embedding or search', async () => {
  const f = await fixture(), calls: string[] = [];
  const server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`); response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/aliases'
      ? { result: { aliases: [{ alias_name: 'framework_wiki', collection_name: 'old_corpus' }] } }
      : { result: { payload: { signature: 'wrong', schema: 'e5-small-480-overlap48-v1' } } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address() as { port: number }, url = `http://127.0.0.1:${address.port}`;
    await assert.rejects(f.run(['--qdrant-url', url, '--embedding-url', url]));
    assert.equal(calls.length, 2); assert.ok(calls.every(call => call.startsWith('GET ')));
    await assert.rejects(stat(f.output), { code: 'ENOENT' });
  } finally { server.close(); await once(server, 'close'); await f.close(); }
});
