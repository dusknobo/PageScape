import { build } from 'esbuild';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const flags = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => i % 2 === 0 ? [...pairs, [arg, all[i + 1]]] : pairs, []));
if (!flags['--workspace'] || !flags['--api'] || !flags['--notebook']) throw new Error('Required: --workspace <absolute> --api <loopback URL> --notebook <id>');
const api = new URL(flags['--api']);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname) || !['http:', 'https:'].includes(api.protocol)) throw new Error('Only a local SiYuan kernel is supported');
const destination = { notebook: flags['--notebook'], ...(flags['--parent'] ? { parentId: flags['--parent'] } : {}) };
if (!/^\d{14}-[a-z0-9]{7}$/.test(destination.notebook) || (destination.parentId && !/^\d{14}-[a-z0-9]{7}$/.test(destination.parentId))) throw new Error('Invalid destination ID');
const originalFetch = globalThis.fetch;
let testCookie = '';
globalThis.fetch = (url, options = {}) => {
  const headers = new Headers(options.headers); if (testCookie) headers.set('Cookie', testCookie);
  return originalFetch(typeof url === 'string' && url.startsWith('/') ? new URL(url, api) : url, { ...options, headers });
};
if (flags['--test-auth-code']) {
  if (api.port !== '6807' || path.resolve(flags['--workspace']).toLowerCase() !== path.join(root, '.test-workspace').toLowerCase()) throw new Error('Test login is restricted to this project test workspace');
  const login = await fetch('/api/system/loginAuth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ authCode: flags['--test-auth-code'] }) });
  if ((await login.json()).code !== 0) throw new Error('Isolated test login failed');
  testCookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
}
const workspace = await (await fetch('/api/system/getWorkspaceInfo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
if (workspace.code !== 0 || path.resolve(workspace.data.workspaceDir).toLowerCase() !== path.resolve(flags['--workspace']).toLowerCase()) throw new Error('The API does not match the explicitly requested workspace');
const output = path.join(root, '.test-build', 'canvas-document-migration-runner.cjs');
await mkdir(path.dirname(output), { recursive: true });
await build({
  absWorkingDir: root, tsconfigRaw: { compilerOptions: { target: 'ES2022' } },
  stdin: { contents: `
    import {CanvasDocumentStore} from './src/canvas/document-store';
    import {createCanvasMigrationIO} from './src/canvas/migration-io';
    import {loadCanvasMigrationManifest,migrateLegacyCanvases} from './src/canvas/migration';
    export async function run(destination) {
      const io=createCanvasMigrationIO('siyuan-child-cards');
      const saved=await loadCanvasMigrationManifest(io);
      const fixed=saved?.destination||destination;
      const store=new CanvasDocumentStore('siyuan-child-cards');
      return migrateLegacyCanvases(io,{
        allocateDocId:()=>store.allocateDocId(),
        findByLegacyId:id=>store.findByLegacyId(id),
        createFromLegacy:async(scene,legacyId,runId,reservedId)=>(await store.importLegacy(scene,legacyId,runId,reservedId,fixed)).id,
        load:(id,legacyId)=>store.load(id,legacyId)
      },{confirmed:true,destination:fixed});
    }`, loader: 'ts', sourcefile: path.join(root, 'migration-entry.ts') },
  bundle: true, outfile: output, format: 'cjs', platform: 'node', target: 'node22', packages: 'external',
  plugins: [{ name: 'scoped-local-migration', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      if (args.path === 'siyuan') return { path: 'siyuan', namespace: 'sdk-stub' };
      const resolved = path.resolve(args.importer ? path.dirname(args.importer) : root, args.path);
      if (!resolved.startsWith(root + path.sep)) throw new Error('Migration source must stay in this project');
      return { path: path.extname(resolved) ? resolved : resolved + '.ts', namespace: 'workspace-migration' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'workspace-migration' }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'ts' }));
    builder.onLoad({ filter: /.*/, namespace: 'sdk-stub' }, () => ({ contents: `export const Constants={SIYUAN_APPID:'canvas-document-migration-cli'};`, loader: 'js' }));
  } }],
});
const sourceRoot = path.resolve(flags['--workspace'], 'data/storage/petal/siyuan-child-cards');
const sha = value => createHash('sha256').update(value).digest('hex');
const sourceFiles = (await readdir(sourceRoot)).filter(name => /^canvas-[a-z0-9_-]+\.json$/.test(name) && name !== 'canvas-migration.json');
const snapshot = new Map(); for (const name of sourceFiles) snapshot.set(name, await readFile(path.join(sourceRoot, name)));
const offlineBackup = path.join(root, '.qa', 'legacy-canvas-json-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(offlineBackup, { recursive: true });
for (const [name, bytes] of snapshot) {
  const target = path.join(offlineBackup, name); await writeFile(target, bytes, { flag: 'wx' });
  if (sha(await readFile(target)) !== sha(bytes)) throw new Error('Offline raw JSON backup failed');
}
globalThis.window = { siyuan: { config: { readonly: false }, isPublish: false } };
const result = await createRequire(import.meta.url)(output).run(destination);
for (const [name, bytes] of snapshot) if (sha(await readFile(path.join(sourceRoot, name))) !== sha(bytes)) throw new Error('A legacy original changed during migration');
const report = { workspace: workspace.data.workspaceDir, migrated: result.boards.length, destination: result.destination, mapping: result.mapping,
  stage: result.stage, backup: path.join(sourceRoot, 'canvas-backups', result.runId), offlineBackup,
  files: result.files, runId: result.runId };
await writeFile(path.join(offlineBackup, 'migration-report.json'), JSON.stringify(report, null, 2));
await writeFile(path.join(root, '.qa', 'canvas-migration-latest.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
