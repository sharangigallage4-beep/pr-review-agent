import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadUpload, UPLOAD_LIMITS, type UploadLimits } from './uploadInput.js';
import { LocalInputError } from './localInput.js';

const b64 = (text: string): string => Buffer.from(text).toString('base64');
const file = (path: string, text: string) => ({ path, data: b64(text) });

/** A minimal ZIP with one stored (uncompressed) file, built by hand so the test needs no zip library. */
function zipOf(name: string, text: string): Buffer {
  const data = Buffer.from(text);
  const nameBuf = Buffer.from(name);
  const crc = crc32(data);
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
  const centralOffset = local.length + nameBuf.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}


describe('loadUpload', () => {
  test('loose files and a picked folder come through by path', () => {
    const { files, notes } = loadUpload({ files: [file('a.js', 'one'), file('src/b.js', 'two')] }, 'new version');
    assert.deepEqual([...files.keys()].sort(), ['a.js', 'src/b.js']);
    assert.equal(files.get('src/b.js')?.toString(), 'two');
    assert.deepEqual(notes, []);
  });

  test('git and node_modules folders are left out silently, and unsafe paths are skipped with a note', () => {
    const { files, notes } = loadUpload(
      { files: [file('app/.git/config', 'x'), file('app/node_modules/pkg/i.js', 'x'), file('../escape.js', 'x'), file('app/ok.js', 'x')] },
      'new version'
    );
    assert.deepEqual([...files.keys()], ['app/ok.js']);
    assert.equal(notes.length, 1);
    assert.match(notes[0] ?? '', /not a usable file path/);
  });

  test('a single ZIP is unpacked like a folder', () => {
    const { files } = loadUpload({ files: [{ path: 'solution.zip', data: zipOf('proj/x.plsql', 'select 1').toString('base64') }] }, 'new version');
    assert.equal(files.get('proj/x.plsql')?.toString(), 'select 1');
  });

  test('a ZIP that is not a ZIP is a message for the user, not a crash', () => {
    assert.throws(() => loadUpload({ files: [file('bad.zip', 'not a zip')] }, 'new version'), (e: unknown) => e instanceof LocalInputError && /ZIP could not be read/.test(e.message));
  });

  test('nothing chosen, a wrong shape and too many files are refused with a clear message', () => {
    assert.throws(() => loadUpload(undefined, 'new version'), /Choose the new version files first/);
    assert.throws(() => loadUpload({ files: [] }, 'previous version'), /Choose the previous version files first/);
    assert.throws(() => loadUpload({ files: [{ path: 1, data: 2 }] }, 'new version'), /not in the expected format/);
    const small: UploadLimits = { ...UPLOAD_LIMITS, maxFiles: 2 };
    assert.throws(() => loadUpload({ files: [file('a', '1'), file('b', '2'), file('c', '3')] }, 'new version', small), /too many files/);
  });

  test('a file over the size limit is skipped with a note; the total limit refuses the whole upload', () => {
    const tiny: UploadLimits = { ...UPLOAD_LIMITS, maxFileBytes: 10, maxTotalBytes: 25 };
    const { files, notes } = loadUpload({ files: [file('big.js', 'x'.repeat(50)), file('ok.js', 'fine')] }, 'new version', tiny);
    assert.deepEqual([...files.keys()], ['ok.js']);
    assert.match(notes[0] ?? '', /Skipped big\.js/);
    assert.throws(() => loadUpload({ files: [file('a', 'x'.repeat(10)), file('b', 'x'.repeat(10)), file('c', 'x'.repeat(10))] }, 'new version', tiny), /larger than/);
  });

  test('when everything was skipped there is a reason, not an empty review', () => {
    assert.throws(() => loadUpload({ files: [file('node_modules/x.js', '1')] }, 'new version'), /No usable files/);
  });
});
