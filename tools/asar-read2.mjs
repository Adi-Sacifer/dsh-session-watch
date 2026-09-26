#!/usr/bin/env node
'use strict';
/*
 * asar-read2.mjs - list/read files inside an Electron .asar, locating payloads by their own
 * SHA256 integrity hashes instead of by an assumed prologue formula.
 *
 * WHY NOT THE FORMULA
 *   The obvious approach - parse the header, then compute `dataStart + entry.offset` - produced a
 *   reader that parsed the header perfectly, listed 12875 plausible paths, and then silently
 *   returned bytes from a NEIGHBOURING file for every read. It was off by a few bytes, and nothing
 *   failed loudly. Candidate prologue formulas were tried and all of them were wrong by 6-8 bytes.
 *
 * HOW THIS WORKS INSTEAD
 *   Each entry records `integrity.hash` = SHA256 of exactly that file's bytes. So the payload can
 *   be located by searching for the position whose bytes hash to the recorded value. That is
 *   ground truth taken from the archive itself, not from a remembered format.
 *
 *   Searching the whole 112 MB archive per file would be far too slow, so the search window is
 *   anchored on the arithmetic guess and kept small; the very first entry is solved from scratch
 *   (cached for the process), and every later entry is found by walking forward from the previous
 *   one, since payloads are contiguous and 4-byte aligned.
 *
 * Usage:
 *   node asar-read2.mjs list <asar> [substring]
 *   node asar-read2.mjs read <asar> <path>
 *   node asar-read2.mjs solve <asar>
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const [mode, archivePath, arg] = process.argv.slice(2);
if (!mode || !archivePath) {
  console.error('usage: asar-read2.mjs list|read|solve <asar> [filter|path]');
  process.exit(2);
}

const fd = fs.openSync(archivePath, 'r');
const ARCHIVE_SIZE = fs.statSync(archivePath).size;

const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerJsonSize = head.readUInt32LE(12);
const headerBuf = Buffer.alloc(headerJsonSize);
fs.readSync(fd, headerBuf, 0, headerJsonSize, 16);
const table = JSON.parse(headerBuf.toString('utf8'));

/* flatten to ordered entries: the directory table preserves payload order */
const entries = [];
(function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(entry, p);
    else entries.push({ path: p, size: Number(entry.size || 0), offset: Number(entry.offset || 0), unpacked: Boolean(entry.unpacked), hash: entry.integrity?.hash ?? null });
  }
})(table, '');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readAt = (at, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, at); return b; };

/* one absolute dataStart for the whole archive, solved from the first hashed entry */
let dataStart = null;
function solveDataStart() {
  if (dataStart !== null) return dataStart;
  const probe = entries.find((e) => e.hash && e.size > 0 && !e.unpacked);
  if (!probe) throw new Error('no hashed entry to calibrate against');
  const guess = 12 + headerJsonSize + probe.offset;
  for (let delta = -4096; delta <= 4096; delta++) {
    const at = guess + delta;
    if (at < 0 || at + probe.size > ARCHIVE_SIZE) continue;
    if (sha(readAt(at, probe.size)) === probe.hash) {
      dataStart = at - probe.offset;
      return dataStart;
    }
  }
  throw new Error(`could not locate payloads for ${probe.path} within ±4096 bytes of the guess`);
}

/* find one entry's absolute payload position by walking from a known anchor */
function locate(target) {
  const base = solveDataStart();
  const guess = base + target.offset;
  if (target.hash && guess + target.size <= ARCHIVE_SIZE && sha(readAt(guess, target.size)) === target.hash) return guess;
  // fall back to a bounded search around the guess
  for (let delta = -4096; delta <= 4096; delta++) {
    const at = guess + delta;
    if (at < 0 || at + target.size > ARCHIVE_SIZE) continue;
    if (!target.hash) break;
    if (sha(readAt(at, target.size)) === target.hash) return at;
  }
  if (!target.hash) return guess;   // no integrity recorded: best effort
  throw new Error(`could not locate payload for ${target.path}`);
}

function readEntry(entry) {
  if (entry.unpacked) {
    const dir = archivePath + '.unpacked';
    const p = `${dir}/${entry.path}`;
    if (fs.existsSync(p)) return fs.readFileSync(p);
    throw new Error(`[unpacked] expected at ${p}`);
  }
  return readAt(locate(entry), entry.size);
}

if (mode === 'solve') {
  const base = solveDataStart();
  console.log(`archive          : ${archivePath} (${(ARCHIVE_SIZE / 1048576).toFixed(1)} MB)`);
  console.log(`headerJsonSize   : ${headerJsonSize}`);
  console.log(`payloads start at: ${base}   (file data begins after the JSON prologue)`);
  console.log(`entries          : ${entries.length}`);
  const verified = entries.filter((e) => e.hash && !e.unpacked).slice(0, 25)
    .map((e) => { try { locate(e); return true; } catch { return false; } });
  console.log(`spot-check       : ${verified.filter(Boolean).length}/${verified.length} entries located by hash`);
  process.exit(0);
}

if (mode === 'list') {
  const filter = (arg || '').toLowerCase();
  const hits = filter ? entries.filter((e) => e.path.toLowerCase().includes(filter)) : entries;
  console.log(`total files: ${entries.length}   matching: ${hits.length}`);
  for (const e of hits.slice(0, 400)) console.log(`${String(e.size).padStart(9)}  ${e.path}`);
  if (hits.length > 400) console.log(`... ${hits.length - 400} more`);
  process.exit(0);
}

if (mode === 'read') {
  const want = (arg || '').replace(/\\/g, '/').replace(/^\//, '');
  const entry = entries.find((e) => e.path === want);
  if (!entry) { console.error('not found in archive: ' + want); process.exit(1); }
  process.stdout.write(readEntry(entry));
  process.exit(0);
}

console.error('unknown mode: ' + mode);
process.exit(2);
