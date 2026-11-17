// Identity of the synced shared code (C01 section 1/6). R\shared\ ("S\") is canonical; TG Bot\src\shared\ holds byte-identical copies written only by
// R\scripts\sync-shared.ps1. This file checks ALL of S\ (every file that does not end in .test.ts), so a package that adds a file under S\ is covered
// as soon as it syncs. It is itself the one test file allowed in src\shared\. The Engine has the same test (plus the mutation checks of
// the comparison logic, C01 acceptance rows 13 and 14) next to its own copies.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SHARED_ROOT = path.resolve(__dirname, '..', '..', '..', 'shared');   // R\shared  (src\shared -> src -> TG Bot -> R)
const COPY_ROOT = __dirname;                                                // TG Bot\src\shared
const IDENTITY_TEST = 'shared-identity.test.ts';
/** A-134 (R9-CL1): canonical files this service never imports; scripts/sync-shared.ps1 does not copy them here (its TG Bot skip list is the same list). */
const NOT_COPIED_HERE: readonly string[] = ['dashboard/measured.ts'];

/** Every file under root as a '/'-separated relative path, sorted. */
function listFiles(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...listFiles(root, r));
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

/** Problems of a copy folder against its canonical folder; an empty list means identical. The identity test file is the only copy-side file without a source. */
function compareShared(sourceRoot: string, copyRoot: string): string[] {
  const problems: string[] = [];
  const sources = listFiles(sourceRoot).filter(r => !r.endsWith('.test.ts') && !NOT_COPIED_HERE.includes(r));
  const copies = listFiles(copyRoot).filter(r => r !== IDENTITY_TEST);
  const sourceSet = new Set(sources);
  const copySet = new Set(copies);
  for (const r of sources) {
    if (!copySet.has(r)) problems.push(`missing copy: ${r}`);
    else if (Buffer.compare(fs.readFileSync(path.join(sourceRoot, r)), fs.readFileSync(path.join(copyRoot, r))) !== 0) problems.push(`differs: ${r}`);
  }
  for (const r of copies) if (!sourceSet.has(r)) problems.push(`extra file in copy: ${r}`);
  return problems;
}

describe('shared code identity (TG Bot copy)', () => {
  it('every file of S\\ has a byte-identical copy in TG Bot/src/shared and no copy lacks a source', () => {
    const sources = listFiles(SHARED_ROOT).filter(r => !r.endsWith('.test.ts'));
    for (const r of ['common/ids.ts', 'common/card-types.ts', 'dashboard/freshness.ts', 'dashboard/measured.ts', 'dashboard/contract.ts', 'contract/v1.ts']) {
      expect(sources, 'S\\ must hold the round-0a files').toContain(r);
    }
    expect(compareShared(SHARED_ROOT, COPY_ROOT)).toEqual([]);
  });

  it('R9CL4-T03 the TG Bot copy of dashboard/measured.ts is gone because nothing in TG Bot/src imports it; the canonical file and the Engine copy stay; the sync script skips it for this target only', () => {
    expect(fs.existsSync(path.join(COPY_ROOT, 'dashboard', 'measured.ts'))).toBe(false);
    expect(fs.existsSync(path.join(SHARED_ROOT, 'dashboard', 'measured.ts'))).toBe(true);
    expect(fs.existsSync(path.join(SHARED_ROOT, '..', 'Engine', 'src', 'shared', 'dashboard', 'measured.ts'))).toBe(true);
    const sync = fs.readFileSync(path.join(SHARED_ROOT, '..', 'scripts', 'sync-shared.ps1'), 'utf8');
    expect(sync).toMatch(/Label = 'TG Bot'[^\r\n]*Skip = @\('dashboard\\measured\.ts'\)/);
    expect(sync).toMatch(/Label = 'Engine'[^\r\n]*Skip = @\(\)/);
    // zero importers in this service: no source file names the module (this file holds the list above, it does not import it)
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const f of walk(path.resolve(COPY_ROOT, '..')).filter((x) => x.endsWith('.ts') && !x.endsWith('shared-identity.test.ts'))) {
      expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/dashboard\/measured|from '\.\/measured'/);
    }
  });
});
