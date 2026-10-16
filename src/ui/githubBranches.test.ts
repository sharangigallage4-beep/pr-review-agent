import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BRANCH_PATTERN, listBranches, loadBranch } from './githubBranches.js';
import { LocalInputError } from './localInput.js';
import { UPLOAD_LIMITS } from './uploadInput.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A minimal ZIP with one stored (uncompressed) file, built by hand so the test needs no zip library. */
function zipOf(name: string, text: string): Buffer {
  const data = Buffer.from(text);
  const nameBuf = Buffer.from(name);
  let crc = ~0;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  crc = ~crc >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(local.length + nameBuf.length + data.length, 16);
  return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]);
}

describe('listBranches', () => {
  test('lists the branches with the default one first, then alphabetically', async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      if (url.endsWith('/repos/acme/widgets')) return json({ default_branch: 'main' });
      return json([{ name: 'topic/z' }, { name: 'main' }, { name: 'dev' }]);
    }) as unknown as typeof fetch;
    const branches = await listBranches('acme', 'widgets', 'tok', fetchFn);
    assert.deepEqual(branches, [
      { name: 'main', isDefault: true },
      { name: 'dev', isDefault: false },
      { name: 'topic/z', isDefault: false },
    ]);
    assert.ok(urls.every((u) => u.startsWith('https://api.github.com/repos/acme/widgets')));
  });

  test('explains a missing repository and a rejected token in plain words', async () => {
    const notFound = (async () => json({}, 404)) as unknown as typeof fetch;
    await assert.rejects(() => listBranches('acme', 'nope', 'tok', notFound), (e: unknown) => e instanceof LocalInputError && /acme\/nope was not found/.test(e.message));
    const rejected = (async () => json({}, 401)) as unknown as typeof fetch;
    await assert.rejects(() => listBranches('acme', 'x', 'tok', rejected), /rejected the token/);
  });
});

describe('loadBranch', () => {
  test('downloads the branch ZIP and unpacks it in memory, sending the token only to GitHub', async () => {
    let seen: { url: string; auth: string } | undefined;
    const fetchFn = (async (url: string, init: { headers: Record<string, string> }) => {
      seen = { url, auth: init.headers.Authorization as string };
      return new Response(zipOf('acme-widgets-abc123/src/a.js', 'console.log(1)'), { status: 200 });
    }) as unknown as typeof fetch;
    const { files } = await loadBranch('acme', 'widgets', 'topic/old', 'tok', fetchFn);
    assert.equal(files.get('acme-widgets-abc123/src/a.js')?.toString(), 'console.log(1)');
    assert.equal(seen?.url, 'https://api.github.com/repos/acme/widgets/zipball/topic/old');
    assert.equal(seen?.auth, 'Bearer tok');
  });

  test('refuses a bad branch name before any request is made', async () => {
    const fetchFn = (async () => {
      throw new Error('must not be called');
    }) as unknown as typeof fetch;
    for (const bad of ['', '../etc', 'a b', 'x'.repeat(201), 'main?x=1']) {
      await assert.rejects(() => loadBranch('acme', 'w', bad, 'tok', fetchFn), /not valid/, `"${bad}"`);
    }
    assert.equal(BRANCH_PATTERN.test('release/2026.10_a-b'), true);
  });

  test('gives up on a download larger than the limit', async () => {
    const big = (async () => new Response(Buffer.alloc(5000), { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(
      () => loadBranch('acme', 'w', 'main', 'tok', big, { maxDownloadBytes: 1000, zip: UPLOAD_LIMITS.zip }),
      (e: unknown) => e instanceof LocalInputError && /larger than/.test(e.message)
    );
  });

  test('a missing branch and a body that is not a ZIP are plain messages', async () => {
    const missing = (async () => json({}, 404)) as unknown as typeof fetch;
    await assert.rejects(() => loadBranch('acme', 'w', 'gone', 'tok', missing), /Could not download the branch "gone"/);
    const notZip = (async () => new Response('hello', { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(() => loadBranch('acme', 'w', 'main', 'tok', notZip), /could not be read/);
  });
});
