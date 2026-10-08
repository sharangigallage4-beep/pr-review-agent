import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalInputError, listLocalInputs, loadLocalInput } from './localInput.js';

/** A one-file stored (uncompressed) ZIP, just enough for the reader. */
function tinyZip(name: string, text: string): Buffer {
  const data = Buffer.from(text);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(0x800, 8);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBytes.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length + nameBytes.length, 12);
  eocd.writeUInt32LE(local.length + nameBytes.length + data.length, 16);
  return Buffer.concat([local, nameBytes, data, cd, nameBytes, eocd]);
}

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), 'local-input-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('listLocalInputs', () => {
  test('lists folders and .zip files only, ignoring hidden entries and other files', () =>
    withRoot((root) => {
      mkdirSync(path.join(root, 'customer-solution-new'));
      mkdirSync(path.join(root, '.hidden'));
      writeFileSync(path.join(root, 'old.ZIP'), 'x');
      writeFileSync(path.join(root, 'notes.txt'), 'x');
      assert.deepEqual(listLocalInputs(root), [
        { name: 'customer-solution-new', kind: 'folder' },
        { name: 'old.ZIP', kind: 'zip' },
      ]);
    }));

  test('a missing folder is an empty list', () => {
    assert.deepEqual(listLocalInputs(path.join(tmpdir(), 'no-such-local-input-folder')), []);
  });
});

describe('loadLocalInput', () => {
  test('reads a folder recursively with forward-slash paths, skipping .git and node_modules', () =>
    withRoot((root) => {
      const dir = path.join(root, 'sol');
      mkdirSync(path.join(dir, 'purch', 'source'), { recursive: true });
      mkdirSync(path.join(dir, '.git'));
      mkdirSync(path.join(dir, 'node_modules'));
      writeFileSync(path.join(dir, 'purch', 'source', 'A-Cust.plsql'), 'code');
      writeFileSync(path.join(dir, '.gitattributes'), 'attr');
      writeFileSync(path.join(dir, '.git', 'config'), 'secret');
      writeFileSync(path.join(dir, 'node_modules', 'x.js'), 'lib');
      const { files, notes } = loadLocalInput(root, 'sol');
      assert.deepEqual([...files.keys()].sort(), ['.gitattributes', 'purch/source/A-Cust.plsql']);
      assert.deepEqual(notes, []);
    }));

  test('reads a ZIP entry of the folder', () =>
    withRoot((root) => {
      writeFileSync(path.join(root, 'v1.zip'), tinyZip('order/a.projection', 'projection X;'));
      const { files } = loadLocalInput(root, 'v1.zip');
      assert.equal(files.get('order/a.projection')?.toString(), 'projection X;');
    }));

  test('refuses anything that is not exactly one of the listed entries', () =>
    withRoot((root) => {
      mkdirSync(path.join(root, 'sol'));
      writeFileSync(path.join(root, 'notes.txt'), 'x');
      for (const bad of ['../etc', 'sol/..', 'sol/sub', '..\\x', '/abs', 'C:\\Windows', 'missing', 'notes.txt', '.hidden', '']) {
        assert.throws(() => loadLocalInput(root, bad), LocalInputError, JSON.stringify(bad));
      }
    }));

  test('notes an oversized file instead of reading it, and enforces the totals', () =>
    withRoot((root) => {
      const dir = path.join(root, 'sol');
      mkdirSync(dir);
      writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(2000));
      writeFileSync(path.join(dir, 'small.txt'), 'ok');
      const { files, notes } = loadLocalInput(root, 'sol', { maxEntries: 10, maxFileBytes: 1000, maxTotalBytes: 100_000 });
      assert.deepEqual([...files.keys()], ['small.txt']);
      assert.match(notes[0], /big\.bin.*larger than/);
      assert.throws(() => loadLocalInput(root, 'sol', { maxEntries: 1, maxFileBytes: 1_000_000, maxTotalBytes: 100_000 }), /too many files/);
      assert.throws(() => loadLocalInput(root, 'sol', { maxEntries: 10, maxFileBytes: 1_000_000, maxTotalBytes: 1000 }), /larger than/);
    }));
});
