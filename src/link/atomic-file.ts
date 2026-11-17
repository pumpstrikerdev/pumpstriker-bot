// R1-B1 (B10): durable file helpers for the bot's link state (inbox-seen.json, the outbox offset, the outbox and dead-letter lines).
// Atomic replace = write a temp file in the same folder, fsync it, rename it over the target (a crash leaves the old file or the new one,
// never half of one). The rename is retried a few times on EPERM/EBUSY/EACCES: on Windows an antivirus scan or an indexer can hold the
// target for a moment.
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

const RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 6;
let tmpCounter = 0;

function tmpName(file: string): string {
  tmpCounter = (tmpCounter + 1) % 1_000_000;
  return `${file}.${process.pid}.${tmpCounter}.tmp`;
}

function codeOf(e: unknown): string {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : '';
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Atomic replace, synchronous (small files on the critical path, such as the outbox offset). Throws when it cannot write. */
export function writeFileAtomicSync(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tmpName(file);
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (e) {
        if (attempt >= RENAME_ATTEMPTS || !RETRY_CODES.has(codeOf(e))) throw e;
        sleepSync(10 * attempt);
      }
    }
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

/** Atomic replace, asynchronous (does not block the event loop; used for the inbox files that are rewritten on every event). */
export async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = tmpName(file);
  try {
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    for (let attempt = 1; ; attempt++) {
      try {
        await fsp.rename(tmp, file);
        return;
      } catch (e) {
        if (attempt >= RENAME_ATTEMPTS || !RETRY_CODES.has(codeOf(e))) throw e;
        await new Promise<void>(resolve => { setTimeout(resolve, 10 * attempt); });
      }
    }
  } catch (e) {
    try { await fsp.rm(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

/** Append one line (the caller supplies the trailing newline) and fsync before returning. Returns the bytes written. Throws on failure. */
export function appendDurable(file: string, text: string): number {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = Buffer.from(text, 'utf8');
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return buf.length;
}
