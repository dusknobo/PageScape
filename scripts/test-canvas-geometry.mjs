import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = path.join(root, '.test-build');
const entries = { 'canvas-geometry.test': 'tests/canvas-geometry.test.ts', 'canvas-assets.test': 'tests/canvas-assets.test.ts', 'canvas-features.test': 'tests/canvas-features.test.ts', 'plugin-id-migration.test': 'tests/plugin-id-migration.test.ts' };
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root, entryPoints: Object.fromEntries(Object.keys(entries).map(name => [name, name])), bundle: true, outdir: output, outExtension: { '.js': '.cjs' },
  format: 'cjs', platform: 'node', target: 'node22', packages: 'external', sourcemap: 'inline', legalComments: 'none',
  plugins: [{ name: 'workspace-geometry-tests', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      if (args.path.startsWith('node:')) return { path: args.path, external: true };
      const resolved = args.kind === 'entry-point' ? path.join(root, entries[args.path]) : path.resolve(path.dirname(args.importer), args.path);
      if (!resolved.startsWith(root + path.sep)) throw new Error('Test imports must stay inside the project');
      return { path: path.extname(resolved) ? resolved : `${resolved}.ts`, namespace: 'workspace-geometry-tests' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'workspace-geometry-tests' }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'ts' }));
  } }],
});
const result = spawnSync(process.execPath, ['--test', ...Object.keys(entries).map(name => path.join(output, `${name}.cjs`))], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
