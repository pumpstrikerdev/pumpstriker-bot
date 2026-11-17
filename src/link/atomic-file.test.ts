// R1-B1: the durable file helpers behind the inbox, the outbox offset and the outbox lines.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appendDurable, writeFileAtomic, writeFileAtomicSync } from './atomic-file';
import { cleanupTempDirs, tempDir } from './link-testkit';

afterAll(() => { cleanupTempDirs(); });

describe('atomic files', () => {
  it('replaces a file whole, creates the folder, and leaves no temp file behind (sync)', () => {
    const dir = path.join(tempDir(), 'a', 'b');
    const file = path.join(dir, 'x.json');
    writeFileAtomicSync(file, '{"v":1}');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"v":1}');
    writeFileAtomicSync(file, Buffer.from('{"v":2}', 'utf8'));
    expect(fs.readFileSync(file, 'utf8')).toBe('{"v":2}');
    expect(fs.readdirSync(dir)).toEqual(['x.json']);
  });

  it('replaces a file whole and leaves no temp file behind (async)', async () => {
    const dir = path.join(tempDir(), 'c');
    const file = path.join(dir, 'y.json');
    await writeFileAtomic(file, 'one');
    await writeFileAtomic(file, 'two');
    expect(fs.readFileSync(file, 'utf8')).toBe('two');
    expect(fs.readdirSync(dir)).toEqual(['y.json']);
  });

  it('keeps the old file and removes its temp file when the target cannot be replaced', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'taken');
    fs.mkdirSync(target);                                            // a folder where the file should go: the rename fails
    expect(() => writeFileAtomicSync(target, 'x')).toThrow();
    await expect(writeFileAtomic(target, 'x')).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual(['taken']);
  });

  it('appends a line durably and reports the bytes written', () => {
    const file = path.join(tempDir(), 'sub', 'lines.jsonl');
    expect(appendDurable(file, '{"a":1}\n')).toBe(8);
    expect(appendDurable(file, '{"é":2}\n')).toBe(9);                // multi-byte characters count as bytes
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}\n{"é":2}\n');
  });
});
