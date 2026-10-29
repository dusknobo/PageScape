import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { PACKAGE_FILES } from './package-files.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'plugin.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
assert.equal(manifest.name, 'siyuan-child-cards', 'Preserve IDs used by existing documents and plugin storage');
assert.equal(manifest.version, pkg.version); assert.equal(pkg.version, lock.version); assert.equal(pkg.version, lock.packages[''].version);
assert.equal(manifest.url, 'https://github.com/dusknobo/PageScape');
assert.match(manifest.displayName.default, /PageScape/);
const bytes = await readFile(path.join(root, 'package.zip'));
const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
const files = Object.values(zip.files).filter(file => !file.dir).map(file => file.name).sort();
assert.deepEqual(files, [...PACKAGE_FILES].sort(), 'Only explicitly allowed release files may be packaged');
for (const name of files) {
  assert.ok(!name.includes('..') && !name.startsWith('/') && !name.includes('\\'));
  const data = await zip.file(name).async('nodebuffer');
  assert.deepEqual(data, await readFile(path.join(root, 'dist', name)), `Archive matches built file: ${name}`);
  if (!name.endsWith('.png')) {
    const text = data.toString('utf8');
    assert.ok(!/C:[\\/]Users[\\/]hz[\\/]|E:[\\/]笔记|(?:43\.167\.193\.85|192\.168\.110\.39)/.test(text), `Personal machine data found in ${name}`);
  }
}
const sha256 = createHash('sha256').update(bytes).digest('hex');
await writeFile(path.join(root, 'dist', 'SHA256SUMS'), `${sha256}  package.zip\n`);
console.log(JSON.stringify({ name: manifest.displayName.default, id: manifest.name, version: manifest.version, files: files.length, bytes: bytes.length, sha256 }));
