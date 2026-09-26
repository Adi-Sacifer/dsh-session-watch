/**
 * archive.js - read a DSH session transcript. No CLI, no output, just records.
 *
 * WHY THIS IS ITS OWN FILE
 *   Reading a transcript is the one thing every part of this plugin must agree on, and it is easy
 *   to get subtly wrong. Keeping it here means the verdict pass and the diagnosis pass cannot drift
 *   apart in how they see a session.
 *
 * THE TRAP, measured against real sessions
 *   `session.v4.jsonl.zstd` is NOT one compressed stream. It is an append-only log of independent
 *   zstd frames, one per flush. `zstdDecompressSync()` and the streaming API both stop after the
 *   FIRST frame and hand back a few hundred bytes that look like an empty conversation. The way in
 *   is to walk the frame magic (28 B5 2F FD), inflate each frame between boundaries, and
 *   concatenate. A frame body can contain those bytes by chance, so a frame that fails to inflate
 *   is merged forward until it decodes. A trailing half frame is normal on a live session.
 *
 * ZSTD AVAILABILITY
 *   Node 24 has `zlib.zstdDecompressSync`; Electron's bundled Node may not. That is checked here
 *   rather than assumed, and the answer travels with the data so a caller can report "I cannot
 *   read" instead of silently looking healthy.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

export const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

export const hasZstd = typeof zlib.zstdDecompressSync === 'function';

export const unavailableReason = hasZstd
  ? null
  : `zstd decompression is unavailable in this runtime (node ${process.versions.node}), so transcripts cannot be read`;

/** All JSONL records of one transcript, in order. Throws only on filesystem errors. */
export function readRecords(file) {
  const buf = fs.readFileSync(file);
  const offs = [];
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offs.push(i);
  }
  offs.push(buf.length);
  const parts = [];
  for (let k = 0; k < offs.length - 1; k++) {
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(offs[k], offs[k + 1]))); continue; } catch { }
    for (let j = k + 2; j < offs.length; j++) {
      try { parts.push(zlib.zstdDecompressSync(buf.subarray(offs[k], offs[j]))); k = j - 1; break; } catch { }
    }
  }
  const out = [];
  for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { }
  }
  return out;
}
