import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readZip, normalizeEntryName, ZipError } from './zip.js';

interface Entry {
  name: string;
  data: Buffer | string;
  method?: 0 | 8;
  flags?: number;
  /** Override what the headers claim, to test dishonest archives. */
  claimedSize?: number;
}

/** A small ZIP writer for the tests (CRC is left zero - the reader does not use it). */
function buildZip(entries: Entry[], tail?: { entryCountOverride?: number }): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(entry.name, 'utf8');
    const size = entry.claimedSize ?? data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(entry.flags ?? 0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(entry.flags ?? 0x800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(tail?.entryCountOverride ?? entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, eocd]);
}

describe('readZip', () => {
  test('reads deflated and stored files, skipping folder entries', () => {
    const zip = buildZip([
      { name: 'order/', data: '', method: 0 },
      { name: 'order/a.plsql', data: 'line one\nline two\n'.repeat(50) },
      { name: 'readme.txt', data: 'hello', method: 0 },
    ]);
    const { files, skipped } = readZip(zip);
    assert.deepEqual([...files.keys()].sort(), ['order/a.plsql', 'readme.txt']);
    assert.equal(files.get('readme.txt')?.toString(), 'hello');
    assert.equal(files.get('order/a.plsql')?.toString(), 'line one\nline two\n'.repeat(50));
    assert.deepEqual(skipped, []);
  });

  test('keeps non-ASCII text intact', () => {
    const { files } = readZip(buildZip([{ name: 'ñ/é.txt', data: 'වෙනස් — ok' }]));
    assert.equal(files.get('ñ/é.txt')?.toString(), 'වෙනස් — ok');
  });

  test('reports (does not extract) entries with unsafe paths', () => {
    const { files, skipped } = readZip(buildZip([
      { name: '../evil.txt', data: 'x' },
      { name: '/abs.txt', data: 'x' },
      { name: 'C:\\win.txt', data: 'x' },
      { name: 'ok/fine.txt', data: 'x' },
    ]));
    assert.deepEqual([...files.keys()], ['abs.txt', 'ok/fine.txt'].filter((n) => files.has(n)));
    assert.ok(skipped.some((s) => s.name === '../evil.txt' && s.reason === 'unsafe path'));
    assert.ok(skipped.some((s) => s.name === 'C:\\win.txt'));
    assert.equal(files.has('../evil.txt'), false);
  });

  test('skips password-protected and unsupported-method entries with a reason', () => {
    const zip = buildZip([
      { name: 'secret.txt', data: 'x', flags: 0x801 },
      { name: 'fine.txt', data: 'ok' },
    ]);
    const { files, skipped } = readZip(zip);
    assert.deepEqual([...files.keys()], ['fine.txt']);
    assert.deepEqual(skipped, [{ name: 'secret.txt', reason: 'password protected' }]);
  });

  test('refuses a zip bomb: a huge file is skipped, and a huge total is rejected', () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 0x61); // compresses to almost nothing
    const zip = buildZip([{ name: 'big.txt', data: big }, { name: 'small.txt', data: 'ok' }]);
    const limited = readZip(zip, { maxEntries: 100, maxFileBytes: 1024 * 1024, maxTotalBytes: 10 * 1024 * 1024 });
    assert.deepEqual([...limited.files.keys()], ['small.txt']);
    assert.match(limited.skipped[0].reason, /larger than/);

    assert.throws(
      () => readZip(buildZip([{ name: 'a', data: big }, { name: 'b', data: big }]), { maxEntries: 100, maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 5 * 1024 * 1024 }),
      /unpacks to more than/
    );
  });

  test('a header that understates the real size cannot make it grow', () => {
    const lying = buildZip([{ name: 'a.txt', data: 'x'.repeat(10_000), claimedSize: 10 }]);
    assert.throws(() => readZip(lying), ZipError);
  });

  test('rejects things that are not (valid) zips', () => {
    assert.throws(() => readZip(Buffer.from('not a zip at all, just text')), /does not look like a ZIP/);
    assert.throws(() => readZip(Buffer.alloc(0)), ZipError);
    const good = buildZip([{ name: 'a.txt', data: 'hello' }]);
    assert.throws(() => readZip(good.subarray(0, good.length - 30)), ZipError);
    assert.throws(() => readZip(buildZip([{ name: 'a', data: 'x' }], { entryCountOverride: 3 })), ZipError);
  });

  test('refuses too many entries', () => {
    const zip = buildZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' })));
    assert.throws(() => readZip(zip, { maxEntries: 4, maxFileBytes: 1000, maxTotalBytes: 1000 }), /too many entries/);
  });
});

describe('normalizeEntryName', () => {
  test('cleans separators and leading markers, and rejects escapes', () => {
    assert.equal(normalizeEntryName('a\\b\\c.txt'), 'a/b/c.txt');
    assert.equal(normalizeEntryName('./x/y'), 'x/y');
    assert.equal(normalizeEntryName('/x'), 'x');
    for (const bad of ['', '../a', 'a/../../b', 'C:/x', 'a/..', '//']) assert.equal(normalizeEntryName(bad), undefined, bad);
  });
});
