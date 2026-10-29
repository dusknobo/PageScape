import { build } from 'esbuild';
import JSZip from 'jszip';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PACKAGE_FILES } from './package-files.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = path.join(root, 'dist');
for (const file of PACKAGE_FILES) await mkdir(path.dirname(path.join(dist, file)), { recursive: true });
await build({
  absWorkingDir: root, tsconfigRaw: { compilerOptions: { target: 'ES2022' } },
  entryPoints: [path.join(root, 'src/index.ts')], bundle: true, outfile: path.join(dist, 'index.js'),
  format: 'cjs', platform: 'browser', target: 'es2022', external: ['siyuan'],
  footer: { js: 'module.exports = module.exports.default;' },
  legalComments: 'none', minify: false,
});
const files = PACKAGE_FILES;
for (const file of files.filter(file => !file.startsWith('index.'))) await copyFile(path.join(root, file), path.join(dist, file));
const zip = new JSZip();
for (const file of files) zip.file(file, await readFile(path.join(dist, file)), { date: new Date('2026-01-01T00:00:00Z'), createFolders: false });
await writeFile(path.join(root, 'package.zip'), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(`Built ${files.length} package files: ${path.join(root, 'package.zip')}`);
