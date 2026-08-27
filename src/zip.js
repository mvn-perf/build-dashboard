/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 */
'use strict';

const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;

/**
 * Minimal ZIP reader (stored + deflate entries, ZIP64 central directory) so the
 * action can unpack GitHub artifact archives without a dependency.
 *
 * @param {Buffer} buf
 * @returns {Array<{name: string, size: number, isDirectory: boolean, data: () => Buffer}>}
 */
function readZip(buf) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('readZip expects a Buffer');
  const eocdPos = findEocd(buf);
  if (eocdPos < 0) throw new Error('not a zip file (end of central directory not found)');
  let count = buf.readUInt16LE(eocdPos + 10);
  let cenSize = buf.readUInt32LE(eocdPos + 12);
  let cenOffset = buf.readUInt32LE(eocdPos + 16);

  // ZIP64: any 0xFFFF / 0xFFFFFFFF field means "look in the ZIP64 record".
  if (count === 0xffff || cenSize === 0xffffffff || cenOffset === 0xffffffff) {
    const locPos = eocdPos - 20;
    if (locPos >= 0 && buf.readUInt32LE(locPos) === SIG_EOCD64_LOCATOR) {
      const eocd64 = Number(buf.readBigUInt64LE(locPos + 8));
      if (buf.readUInt32LE(eocd64) !== SIG_EOCD64) throw new Error('corrupt zip64 end of central directory');
      count = Number(buf.readBigUInt64LE(eocd64 + 32));
      cenSize = Number(buf.readBigUInt64LE(eocd64 + 40));
      cenOffset = Number(buf.readBigUInt64LE(eocd64 + 48));
    }
  }

  const entries = [];
  let p = cenOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) throw new Error(`corrupt zip central directory at ${p}`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    const utf8 = (flags & 0x800) !== 0;
    const name = buf.toString(utf8 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    // ZIP64 extra field (id 0x0001) overrides the 0xFFFFFFFF placeholders, in order.
    if (usize === 0xffffffff || csize === 0xffffffff || localOffset === 0xffffffff) {
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = buf.readUInt16LE(e);
        const len = buf.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (usize === 0xffffffff) { usize = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(buf.readBigUInt64LE(q)); q += 8; }
          break;
        }
        e += 4 + len;
      }
    }
    p += 46 + nameLen + extraLen + commentLen;
    const isDirectory = name.endsWith('/');
    entries.push({
      name, size: usize, compressedSize: csize, method, isDirectory,
      data: () => extract(buf, localOffset, method, csize, usize, name),
    });
  }
  return entries;
}

function extract(buf, localOffset, method, csize, usize, name) {
  if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOC) throw new Error(`corrupt local header for ${name}`);
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + csize);
  if (method === 0) return Buffer.from(raw);
  if (method === 8) {
    const out = zlib.inflateRawSync(raw);
    if (usize && out.length !== usize) throw new Error(`size mismatch inflating ${name}: ${out.length} != ${usize}`);
    return out;
  }
  throw new Error(`unsupported zip compression method ${method} for ${name}`);
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * Minimal ZIP writer (deflate), used by tests and the demo to fabricate
 * artifact archives. Not used by the action at runtime.
 * @param {Array<{name: string, data: Buffer|string}>} files
 */
function writeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOC, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CEN, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const cenBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cenBuf, eocd]);
}

let CRC_TABLE;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

module.exports = { readZip, writeZip, crc32 };
