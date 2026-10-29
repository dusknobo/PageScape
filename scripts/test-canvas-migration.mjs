import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = path.join(root, '.test-build', 'canvas-migration.test.cjs');
await mkdir(path.dirname(output), { recursive: true });
await build({
  absWorkingDir: root, tsconfigRaw: { compilerOptions: { target: 'ES2022' } },
  entryPoints: ['canvas-migration-tests'], bundle: true, outfile: output,
  format: 'cjs', platform: 'node', target: 'node22', packages: 'external',
  sourcemap: 'inline', legalComments: 'none',
  plugins: [{
    name: 'workspace-canvas-migration-tests',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.path.startsWith('node:')) return { path: args.path, external: true };
        const resolved = args.kind === 'entry-point'
          ? path.join(root, 'tests', 'canvas-migration.test.ts')
          : path.resolve(path.dirname(args.importer), args.path);
        if (!resolved.startsWith(root + path.sep)) throw new Error('Test imports must stay inside the project');
        return { path: path.extname(resolved) ? resolved : `${resolved}.ts`, namespace: 'workspace-canvas-migration-tests' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'workspace-canvas-migration-tests' }, async args => ({
        contents: await readFile(args.path, 'utf8'), loader: 'ts',
      }));
    },
  }],
});
const result = spawnSync(process.execPath, ['--test', output], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
