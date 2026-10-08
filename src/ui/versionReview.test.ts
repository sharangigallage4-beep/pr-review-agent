import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { alignVersions, runVersionReview, stripCommonRoot } from './versionReview.js';
import type { VersionReviewDeps } from './versionReview.js';
import type { ReviewInput, ReviewResult } from '../review/types.js';

const files = (entries: Record<string, string | Buffer>) => new Map(Object.entries(entries).map(([k, v]) => [k, Buffer.from(v)]));
const noop = () => {};

type FakeReview = NonNullable<VersionReviewDeps['review']>;

function fakeReview(handler?: (input: ReviewInput) => ReviewResult | Promise<ReviewResult>) {
  const calls: ReviewInput[] = [];
  const review = (async (input: ReviewInput) => {
    calls.push(input);
    return handler ? handler(input) : { summary: 'ok', issues: [] };
  }) as FakeReview;
  return { calls, review };
}

const aiIssue = (file: string, line = 1, title = 'AI finding') => ({
  severity: 'medium' as const, file, line, title, explanation: 'because', suggestedFix: 'fix it',
});

describe('stripCommonRoot', () => {
  test('drops one shared wrapper folder, but not when paths already differ at the top', () => {
    assert.deepEqual([...stripCommonRoot(files({ 'sol/a/x.txt': '1', 'sol/b.txt': '2' })).keys()].sort(), ['a/x.txt', 'b.txt']);
    assert.deepEqual([...stripCommonRoot(files({ 'purch/x.txt': '1', 'order/y.txt': '2' })).keys()].sort(), ['order/y.txt', 'purch/x.txt']);
    assert.deepEqual([...stripCommonRoot(files({ 'rootfile.txt': '1', 'sol/y.txt': '2' })).keys()].sort(), ['rootfile.txt', 'sol/y.txt']);
    assert.equal(stripCommonRoot(new Map()).size, 0);
  });
});

describe('alignVersions', () => {
  const keys = (m: Map<string, Buffer>) => [...m.keys()].sort();

  test('leaves matching paths alone, even when every file sits under one real component folder', () => {
    const a = alignVersions(files({ 'a/x.txt': '1', 'a/y.txt': '2' }), files({ 'a/x.txt': '1', 'a/z.txt': '3', 'b/w.txt': '4' }));
    assert.deepEqual([keys(a.oldFiles), keys(a.newFiles)], [['a/x.txt', 'a/y.txt'], ['a/x.txt', 'a/z.txt', 'b/w.txt']]);
  });

  test('removes a wrapper folder that only one version has, whichever one it is', () => {
    const wrapOld = alignVersions(files({ 'customer-solution/a/x.txt': '1' }), files({ 'a/x.txt': '1' }));
    assert.deepEqual(keys(wrapOld.oldFiles), ['a/x.txt']);
    const wrapNew = alignVersions(files({ 'a/x.txt': '1' }), files({ 'customer-solution/a/x.txt': '1' }));
    assert.deepEqual(keys(wrapNew.newFiles), ['a/x.txt']);
  });

  test('a wrapper both versions share needs no stripping: their paths already match', () => {
    const both = alignVersions(files({ 'sol/a.txt': '1' }), files({ 'sol/a.txt': '1' }));
    assert.deepEqual(keys(both.oldFiles), keys(both.newFiles));
  });
});

describe('runVersionReview: finding what changed', () => {
  test('reviews only added and modified text files; unchanged, line-ending-only, binary and ignored files are left out', async () => {
    const { calls, review } = fakeReview();
    const result = await runVersionReview(
      {
        label: 'sol',
        useAi: true,
        oldFiles: files({ 'a/same.txt': 'one\ntwo\n', 'a/crlf.txt': 'one\ntwo\n', 'a/mod.txt': 'old\n', 'a/gone.txt': 'bye\n' }),
        newFiles: files({
          'a/same.txt': 'one\ntwo\n',
          'a/crlf.txt': 'one\r\ntwo\r\n',
          'a/mod.txt': 'new\n',
          'a/added.txt': 'fresh\n',
          'a/image.dat': Buffer.from([1, 2, 0, 3]),
          'node_modules/x/index.js': 'lib\n',
        }),
      },
      { log: noop, review }
    );
    const reviewed = calls.flatMap((c) => c.changedFiles.map((f) => `${f.status}:${f.filename}`)).sort();
    assert.deepEqual(reviewed, ['added:a/added.txt', 'modified:a/mod.txt']);
    assert.match(result.summary, /2 changed file\(s\) \(1 new, 1 modified, 1 removed\)/);
  });

  test('without a previous version every file counts as new, and the summary says so', async () => {
    const { calls, review } = fakeReview();
    const result = await runVersionReview({ label: 'sol', useAi: true, newFiles: files({ 'a.txt': 'x\n', 'b.txt': 'y\n' }) }, { log: noop, review });
    assert.deepEqual(calls[0].changedFiles.map((f) => f.status), ['added', 'added']);
    assert.match(result.summary, /no previous version given/);
  });

  test('identical versions produce an empty result with a clear message', async () => {
    const { calls, review } = fakeReview();
    const same = files({ 'a.txt': 'x\n' });
    const result = await runVersionReview({ label: 'sol', useAi: true, newFiles: same, oldFiles: files({ 'a.txt': 'x\n' }) }, { log: noop, review });
    assert.deepEqual(result.findings, []);
    assert.match(result.summary, /No reviewable changes/);
    assert.equal(calls.length, 0);
  });

  test('a wrapper folder in only one version does not make everything look changed', async () => {
    const { calls, review } = fakeReview();
    const result = await runVersionReview(
      { label: 'sol', useAi: true, oldFiles: files({ 'customer-solution/a.txt': 'x\n' }), newFiles: files({ 'a.txt': 'x\n' }) },
      { log: noop, review }
    );
    assert.equal(calls.length, 0);
    assert.match(result.summary, /No reviewable changes/);
  });
});

describe('runVersionReview: the checks', () => {
  const oldProjection = 'projection X;\n';
  const newProjection = 'projection X;\n@Overtake\nquery CFoo {\n}\n';

  test('rule checks run on the changed files even with the AI off, and the model is never called', async () => {
    const { calls, review } = fakeReview();
    const result = await runVersionReview(
      { label: 'sol', useAi: false, oldFiles: files({ 'ShopHandling-Cust.projection': oldProjection }), newFiles: files({ 'ShopHandling-Cust.projection': newProjection }) },
      { log: noop, review }
    );
    assert.equal(calls.length, 0);
    assert.ok(result.findings.some((f) => /BP4/.test(f.title)), 'the @Overtake rule fired');
    assert.match(result.summary, /AI review: off/);
  });

  test('JavaScript syntax errors in a changed file are reported', async () => {
    const { review } = fakeReview();
    const result = await runVersionReview(
      { label: 'sol', useAi: false, oldFiles: files({ 'a.js': 'export const a = 1;\n' }), newFiles: files({ 'a.js': 'export const a = (1;\n' }) },
      { log: noop, review }
    );
    assert.ok(result.findings.some((f) => f.title === 'Syntax error' && f.file === 'a.js'));
  });

  test('AI claims the rule checks cover exactly (e.g. "missing tags") are dropped on IFS files, real ones kept', async () => {
    const { review } = fakeReview(() => ({
      summary: 's',
      issues: [aiIssue('S-Cust.projection', 1, 'Missing start and finish tags'), aiIssue('S-Cust.projection', 2, 'Possible null dereference')],
    }));
    const result = await runVersionReview(
      { label: 'sol', useAi: true, oldFiles: files({ 'S-Cust.projection': 'projection X;\n' }), newFiles: files({ 'S-Cust.projection': 'projection X;\nentity CFoo {\n}\n' }) },
      { log: noop, review }
    );
    const titles = result.findings.map((f) => f.title);
    assert.equal(titles.includes('Missing start and finish tags'), false);
    assert.ok(titles.includes('Possible null dereference'));
  });

  test('AI findings about files outside the batch are dropped; the rest are merged and sorted by severity', async () => {
    const { review } = fakeReview(() => ({ summary: 's', issues: [aiIssue('a.txt', 1, 'real'), aiIssue('invented.txt', 1, 'invented')] }));
    const result = await runVersionReview(
      { label: 'sol', useAi: true, oldFiles: files({ 'ShopHandling-Cust.projection': oldProjection }), newFiles: files({ 'a.txt': 'x\n', 'ShopHandling-Cust.projection': newProjection }) },
      { log: noop, review }
    );
    const titles = result.findings.map((f) => f.title);
    assert.ok(titles.includes('real'));
    assert.equal(titles.includes('invented'), false);
    const order = ['critical', 'high', 'medium', 'low'];
    const ranks = result.findings.map((f) => order.indexOf(f.severity));
    assert.deepEqual(ranks, [...ranks].sort((x, y) => x - y));
  });
});

describe('runVersionReview: batching and failures', () => {
  const many = (n: number, size: number) => files(Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}.txt`, `${'x'.repeat(size)}\n`])));

  test('splits the files into batches that fit the size limit', async () => {
    const { calls, review } = fakeReview();
    await runVersionReview({ label: 'sol', useAi: true, newFiles: many(6, 500) }, { log: noop, review, maxBatchChars: 1500 });
    assert.ok(calls.length >= 2 && calls.length <= 6, `got ${calls.length} batches`);
    assert.equal(calls.flatMap((c) => c.changedFiles).length, 6, 'every file reviewed exactly once');
    for (const call of calls) assert.ok(call.diff.length < 1500 + 400);
  });

  test('a file whose diff is bigger than a batch is truncated for the AI, with a warning', async () => {
    const { calls, review } = fakeReview();
    const result = await runVersionReview({ label: 'sol', useAi: true, newFiles: files({ 'big.txt': Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n') + '\n' }) }, { log: noop, review, maxBatchChars: 1000 });
    assert.match(calls[0].diff, /diff truncated/);
    assert.match(result.summary, /big\.txt: only the first part/);
  });

  test('only maxBatches batches go to the AI, and the summary says the rest was not covered', async () => {
    const { calls, review } = fakeReview();
    const result = await runVersionReview({ label: 'sol', useAi: true, newFiles: many(10, 800) }, { log: noop, review, maxBatchChars: 1000, maxBatches: 2 });
    assert.equal(calls.length, 2);
    assert.match(result.summary, /first 2 of \d+ batches/);
  });

  test('a failing AI batch is reported, not fatal: rule findings and the other batches survive', async () => {
    let n = 0;
    const { review } = fakeReview(() => {
      n += 1;
      if (n === 1) throw new Error('Connection error.');
      return { summary: 's', issues: [aiIssue('f1.txt', 1, 'from batch 2')] };
    });
    const logs: string[] = [];
    const result = await runVersionReview(
      { label: 'sol', useAi: true, oldFiles: files({ 'S-Cust.projection': 'projection X;\n' }), newFiles: { ...Object.fromEntries([]), size: 0 } as never },
      { log: (m) => logs.push(m), review }
    ).catch(() => undefined);
    assert.equal(result, undefined, 'sanity: an invalid input type is not silently accepted');

    n = 0;
    const input = { label: 'sol', useAi: true, oldFiles: files({ 'S-Cust.projection': 'projection X;\n' }), newFiles: new Map([...many(2, 900), ...files({ 'S-Cust.projection': 'projection X;\n@Overtake\nquery CFoo {\n}\n' })]) };
    const ok = await runVersionReview(input, { log: (m) => logs.push(m), review, maxBatchChars: 1000 });
    assert.ok(ok.findings.some((f) => /BP4/.test(f.title)), 'rule findings kept');
    assert.match(ok.summary, /failed - is the AI model running/);
    assert.ok(logs.some((l) => /AI batch 1 failed: Connection error/.test(l)));
  });
});
