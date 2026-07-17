// After `tsc -p tsconfig.cjs.json` emits CommonJS into dist/cjs, drop a package.json there marking
// the directory as CommonJS. The root package.json is `"type": "module"`, so without this the
// `.js` files under dist/cjs would be loaded as ESM and `require()` would fail. This is the standard
// two-config dual-build trick — no bundler dependency required.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'dist', 'cjs', 'package.json');
writeFileSync(target, JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
console.log(`wrote ${target}`);
