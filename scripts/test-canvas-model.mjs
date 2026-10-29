import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = path.join(root, '.test-build', 'canvas-model.test.cjs');
const interopOutput = path.join(root, '.test-build', 'canvas-interop.test.cjs');
await mkdir(path.dirname(output), {recursive: true});
await build({
  absWorkingDir: root, tsconfigRaw: {compilerOptions: {target: 'ES2022'}},
  entryPoints: [{in: 'canvas-model-tests', out: 'canvas-model.test'}, {in: 'canvas-interop-tests', out: 'canvas-interop.test'}], bundle: true, outdir: path.dirname(output), outExtension: {'.js': '.cjs'},
  format: 'cjs', platform: 'node', target: 'node22', packages: 'external',
  sourcemap: 'inline', legalComments: 'none',
  plugins: [{
    name: 'workspace-canvas-tests',
    setup(builder) {
      builder.onResolve({filter: /.*/}, args => {
        if (args.path.startsWith('node:')) return {path: args.path, external: true};
        if (args.path === 'siyuan') return {path: 'siyuan', namespace: 'canvas-siyuan-stub'};
        const resolved = args.kind === 'entry-point'
          ? path.join(root, 'tests', args.path === 'canvas-model-tests' ? 'canvas-model.test.ts' : 'canvas-interop.test.ts')
          : path.resolve(path.dirname(args.importer), args.path);
        if (!resolved.startsWith(root + path.sep)) throw new Error('Test imports must stay inside the project');
        return {path: path.extname(resolved) ? resolved : `${resolved}.ts`, namespace: 'workspace-canvas-tests'};
      });
      builder.onLoad({filter: /.*/, namespace: 'workspace-canvas-tests'}, async args => ({
        contents: await readFile(args.path, 'utf8'), loader: 'ts',
      }));
      builder.onLoad({filter: /.*/, namespace: 'canvas-siyuan-stub'}, () => ({
        contents: 'export const Constants = {SIYUAN_APPID: "canvas-tests"};', loader: 'js',
      }));
    },
  }],
});
const result = spawnSync(process.execPath, ['--test', output, interopOutput], {cwd: root, stdio: 'inherit'});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
