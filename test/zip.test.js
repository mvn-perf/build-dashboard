'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { readZip, writeZip, crc32 } = require('../src/zip');

test('writeZip/readZip round-trip (deflate entries, utf-8 names)', () => {
  const files = [
    { name: 'report.html', data: '<html>' + 'x'.repeat(5000) + '</html>' },
    { name: 'meta.json', data: JSON.stringify({ a: 1, name: 'ünïcode' }) },
    { name: 'sub/dir/ünïcode.txt', data: Buffer.from([0, 1, 2, 255]) },
  ];
  const zip = writeZip(files);
  const entries = readZip(zip);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map(e => e.name), files.map(f => f.name));
  assert.equal(entries[0].data().toString('utf8'), files[0].data);
  assert.equal(entries[1].data().toString('utf8'), files[1].data);
  assert.deepEqual([...entries[2].data()], [0, 1, 2, 255]);
  assert.equal(entries[2].size, 4);
});

test('readZip handles stored (method 0) entries and directory entries', () => {
  // Hand-build a zip with one stored file and one directory entry.
  const name = Buffer.from('a.txt');
  const data = Buffer.from('hello');
  const dirName = Buffer.from('dir/');
  function local(n, d) {
    const b = Buffer.alloc(30); b.writeUInt32LE(0x04034b50, 0); b.writeUInt16LE(10, 4); b.writeUInt16LE(0, 6); b.writeUInt16LE(0, 8);
    b.writeUInt32LE(crc32(d), 14); b.writeUInt32LE(d.length, 18); b.writeUInt32LE(d.length, 22); b.writeUInt16LE(n.length, 26); b.writeUInt16LE(0, 28);
    return Buffer.concat([b, n, d]);
  }
  function central(n, d, off) {
    const b = Buffer.alloc(46); b.writeUInt32LE(0x02014b50, 0); b.writeUInt16LE(10, 4); b.writeUInt16LE(10, 6); b.writeUInt16LE(0, 8); b.writeUInt16LE(0, 10);
    b.writeUInt32LE(crc32(d), 16); b.writeUInt32LE(d.length, 20); b.writeUInt32LE(d.length, 24); b.writeUInt16LE(n.length, 28); b.writeUInt32LE(off, 42);
    return Buffer.concat([b, n]);
  }
  const l1 = local(name, data); const l2 = local(dirName, Buffer.alloc(0));
  const c1 = central(name, data, 0); const c2 = central(dirName, Buffer.alloc(0), l1.length);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(2, 8); eocd.writeUInt16LE(2, 10); eocd.writeUInt32LE(c1.length + c2.length, 12); eocd.writeUInt32LE(l1.length + l2.length, 16);
  const zip = Buffer.concat([l1, l2, c1, c2, eocd]);
  const entries = readZip(zip);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].data().toString(), 'hello');
  assert.equal(entries[1].isDirectory, true);
});

test('readZip rejects non-zip input and unsupported methods', () => {
  assert.throws(() => readZip(Buffer.from('not a zip at all')), /end of central directory/);
  const zip = writeZip([{ name: 'x', data: 'y' }]);
  // Flip the central-directory method to bzip2 (12).
  const cenPos = zip.readUInt32LE(zip.length - 22 + 16);
  zip.writeUInt16LE(12, cenPos + 10);
  assert.throws(() => readZip(zip)[0].data(), /unsupported zip compression method 12/);
});

test('crc32 matches zlib', () => {
  const buf = Buffer.from('The quick brown fox jumps over the lazy dog');
  assert.equal(crc32(buf), zlib.crc32 ? zlib.crc32(buf) : 0x414fa339);
});
