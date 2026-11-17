import * as fs from 'node:fs';
import * as path from 'node:path';
import { defaultExclude, defineConfig } from 'vitest/config';

// PUB-3: src/shared/shared-identity.test.ts compares src/shared with the monorepo's shared/ folder next to this one. A clone of the
// bot alone has no such folder, so the file is left out there (nothing under src/shared/ is edited by hand: it holds the synced
// copies and their identity test). Inside the monorepo it runs as before.
const MONOREPO_SHARED = path.resolve(__dirname, '..', 'shared', 'contract', 'v1.ts');
const OUTSIDE_ONLY = fs.existsSync(MONOREPO_SHARED) ? [] : ['src/shared/shared-identity.test.ts'];
if (OUTSIDE_ONLY.length > 0) console.warn('src/shared/shared-identity.test.ts is skipped: the monorepo folder shared/ it compares with is not in this checkout');

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [...defaultExclude, ...OUTSIDE_ONLY],
    environment: 'node',
    testTimeout: 10000,
    setupFiles: ['src/test-setup.ts'],
    pool: 'forks', // required: process.chdir() throws inside worker threads (vitest 1.6.1 default pool = threads)
  },
});
