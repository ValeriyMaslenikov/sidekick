// Bundles each skill's CLI into one file that runs on plain Node with no node_modules.
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `import x from './file?raw'` → the file's text. */
const rawPlugin = {
  name: 'raw',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw' }));
    b.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }));
  },
};

await build({
  entryPoints: [resolve(root, 'src/punch-list/cli.ts')],
  outfile: resolve(root, 'skills/punch-list/bin/punch-list.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
  plugins: [rawPlugin],
  logLevel: 'warning',
});

const { chmodSync } = await import('node:fs');
chmodSync(resolve(root, 'skills/punch-list/bin/punch-list.mjs'), 0o755);
