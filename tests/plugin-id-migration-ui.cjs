const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const base = 'http://127.0.0.1:6807';
let browser, page;
const report = { passed: [], errors: [], trace: [] };
(async () => {
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  assert.equal((await (await context.request.post(base + '/api/system/loginAuth', { data: { authCode: 'child-cards-isolated-test' } })).json()).code, 0);
  async function api(route, data = {}) {
    const response = await (await context.request.post(base + route, { data })).json();
    assert.equal(response.code, 0, `${route}: ${response.msg}`); return response.data;
  }
  assert.equal(path.resolve((await api('/api/system/getWorkspaceInfo')).workspaceDir).toLowerCase(), path.join(root, '.test-workspace').toLowerCase(), 'Never mutate a user workspace');
  await api('/api/setting/setBazaar', { trust: true, petalDisabled: false });
  if (await fs.stat(path.join(root, '.test-workspace/data/plugins/PageScape/plugin.json')).then(() => true, () => false)) await api('/api/petal/setPetalEnabled', { packageName: 'PageScape', enabled: false });
  await fs.cp(path.join(root, 'dist'), path.join(root, '.test-workspace/data/plugins/PageScape'), { recursive: true });
  const installedManifest = path.join(root, '.test-workspace/data/plugins/PageScape/plugin.json');
  const metadata = JSON.parse(await fs.readFile(installedManifest, 'utf8')); metadata.version += '-qa.' + Date.now();
  await fs.writeFile(installedManifest, JSON.stringify(metadata));
  await api('/api/petal/setPetalEnabled', { packageName: 'PageScape', enabled: true });
  page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  page.on('response', async response => {
    try {
      if (response.url().endsWith('/api/notebook/lsNotebooks')) { const result = await response.json(); report.trace.push({ notebooks: result.data?.notebooks?.map(book => ({ id: book.id, closed: book.closed, encrypted: book.encrypted })) }); }
      if (response.url().endsWith('/api/query/sql') && response.request().postData()?.includes('siyuan-child-cards')) { const result = await response.json(); report.trace.push({ query: JSON.parse(response.request().postData()), rows: result.data }); }
      if (response.url().endsWith('/api/block/getBlockKramdown')) { const result = await response.json(); report.trace.push({ block: result.data?.id, header: result.data?.kramdown?.split('\n')[0] }); }
    } catch {}
  });
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.siyuan?.ws?.app?.plugins?.some(plugin => plugin.name === 'PageScape'), undefined, { timeout: 60000 });
  await page.locator('[data-key="dialog-changelog"] .b3-dialog__scrim').click({ position: { x: 5, y: 5 }, timeout: 1000 }).catch(() => {});
  report.passed.push('PageScape ID loads with native renderers and commands');
  const stamp = Date.now(); const notebook = (await api('/api/notebook/createNotebook', { name: 'Plugin ID QA ' + stamp })).notebook.id;
  for (const book of (await api('/api/notebook/lsNotebooks')).notebooks) if (book.id !== notebook && book.name.startsWith('Plugin ID QA ')) await api('/api/notebook/closeNotebook', { notebook: book.id });
  const board = await page.evaluate(async notebook => {
    const plugin = window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'PageScape');
    const scene = await plugin.canvasStore.create('ID migration canvas', { notebook });
    scene.nodes.push({ id: 'note', kind: 'text', text: '迁移正文保留', x: 30, y: 50, width: 280, height: 220 });
    return await plugin.canvasStore.save(scene, scene.revision);
  }, notebook);
  const canvasBlock = (await api('/api/block/getChildBlocks', { id: board.id })).find(block => ['custom', 'custom_b', 'NodeCustomBlock'].includes(block.type));
  assert.ok(canvasBlock, 'native custom block exists');
  const canvasNew = (await api('/api/block/getBlockKramdown', { id: canvasBlock.id })).kramdown;
  const canvasOld = canvasNew.replace(';;;PageScape/', ';;;siyuan-child-cards/');
  await api('/api/block/updateBlock', { id: canvasBlock.id, dataType: 'markdown', data: canvasOld });
  await api('/api/attr/setBlockAttrs', { id: canvasBlock.id, attrs: { 'custom-migration-test': 'preserved' } });
  const cards = await api('/api/filetree/createDocWithMd', { notebook, path: '/Old cards ' + stamp, markdown: '普通正文保留\n\n;;;siyuan-child-cards/child-cards\n{"version":1,"columns":2}\n;;;\n\n;;;siyuan-child-cards/canvas-reference\n' + JSON.stringify({ format: 'siyuan-child-cards-reference', version: 1, docId: board.id }) + '\n;;;' });
  const originals = new Map();
  originals.set(canvasBlock.id, (await api('/api/block/getBlockKramdown', { id: canvasBlock.id })).kramdown);
  for (const block of await api('/api/block/getChildBlocks', { id: cards })) if (['custom', 'custom_b', 'NodeCustomBlock'].includes(block.type)) originals.set(block.id, (await api('/api/block/getBlockKramdown', { id: block.id })).kramdown);
  assert.equal(originals.size, 3);
  const oldBytes = Buffer.from('{"version":1,"boards":[]}\n');
  async function putFile(file, data) {
    const response = await (await context.request.post(base + '/api/file/putFile', { multipart: { path: file, isDir: 'false', file: { name: path.basename(file), mimeType: 'application/octet-stream', buffer: data } } })).json();
    assert.equal(response.code, 0, response.msg);
  }
  async function getFile(file) {
    const response = await context.request.post(base + '/api/file/getFile', { data: { path: file } });
    if ([202, 404].includes(response.status())) return undefined;
    assert.equal(response.status(), 200); return await response.body();
  }
  await putFile('/data/storage/petal/siyuan-child-cards/canvas-index.json', oldBytes);
  await putFile('/data/storage/petal/siyuan-child-cards/canvas-backups/test/orphan.json', Buffer.from('  original backup\n'));
  let indexed = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const rows = await api('/api/query/sql', { stmt: `SELECT id FROM blocks WHERE box='${notebook}' AND type IN ('custom','custom_b') AND markdown LIKE ';;;siyuan-child-cards/%'`, mode: 'readonly' });
    if (rows.length === 3) { indexed = true; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(indexed, 'legacy fixtures must be indexed before plugin startup');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.siyuan?.ws?.app?.plugins?.some(plugin => plugin.name === 'PageScape'));
  await page.evaluate(() => window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'PageScape').migratePluginId());
  const dialog = page.locator('.scv-feature-dialog').filter({ hasText: '迁移旧版插件 ID' });
  await page.waitForFunction(() => /^(找到|检查停止)/.test(document.querySelector('.scv-feature-status')?.textContent || ''));
  assert.match(await dialog.locator('.scv-feature-status').textContent(), /找到 3 个旧版块、2 个旧存储文件/);
  for (const [id, before] of originals) assert.equal((await api('/api/block/getBlockKramdown', { id })).kramdown, before);
  assert.equal(await getFile('/data/storage/petal/PageScape/canvas-index.json'), undefined);
  report.passed.push('preview lists real legacy custom blocks and storage without writes');
  await dialog.getByRole('button', { name: '备份并迁移 / Migrate', exact: true }).click();
  await dialog.locator('.scv-feature-status').filter({ hasText: '完成：迁移 3 个块，复制 2 个存储文件' }).waitFor();
  for (const [id, before] of originals) assert.equal((await api('/api/block/getBlockKramdown', { id })).kramdown.split('\n;;;')[0], before.split('\n;;;')[0].replace(';;;siyuan-child-cards/', ';;;PageScape/'));
  assert.equal((await api('/api/attr/getBlockAttrs', { id: canvasBlock.id }))['custom-migration-test'], 'preserved');
  assert.deepEqual(await getFile('/data/storage/petal/PageScape/canvas-index.json'), oldBytes);
  assert.deepEqual(await getFile('/data/storage/petal/siyuan-child-cards/canvas-index.json'), oldBytes);
  const backups = await api('/api/file/readDir', { path: '/data/storage/petal/PageScape/plugin-id-backups' });
  assert.equal(backups.filter(file => file.name.endsWith('.md')).length, 3);
  report.passed.push('migration preserves IDs, payloads, attributes, original storage and verified backups');
  const after = await page.evaluate(id => window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'PageScape').canvasStore.load(id), board.id);
  assert.deepEqual(after.nodes, board.nodes); assert.equal(after.id, board.id);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.evaluate(id => window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'PageScape').openDocument(id), board.id);
  await page.locator(`.scv-inline[data-canvas-document="${board.id}"]:visible`).waitFor();
  report.passed.push('migrated native canvas opens and renders inline under PageScape');
  await putFile('/data/storage/petal/PageScape/canvas-index.json', Buffer.from('new plugin edit'));
  await page.evaluate(() => window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'PageScape').migratePluginId());
  await dialog.locator('.scv-feature-status').filter({ hasText: '找到 0 个旧版块、2 个旧存储文件' }).waitFor();
  await dialog.getByRole('button', { name: '备份并迁移 / Migrate', exact: true }).click();
  await dialog.locator('.scv-feature-status').filter({ hasText: '完成：迁移 0 个块，复制 0 个存储文件' }).waitFor();
  assert.deepEqual(await getFile('/data/storage/petal/PageScape/canvas-index.json'), Buffer.from('new plugin edit'));
  report.passed.push('repeat migration keeps later new-plugin storage changes');
  assert.deepEqual(report.errors, []);
  await page.screenshot({ path: path.join(root, '.qa/plugin-id-migration.png'), fullPage: true });
  await fs.writeFile(path.join(root, '.qa/plugin-id-migration-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, errors: report.errors }));
})().catch(async error => {
  if (page) console.error(await page.locator('.scv-feature-status').allTextContents().catch(() => []));
  console.error(JSON.stringify(report.trace));
  console.error(error.stack || error); if (page) await page.screenshot({ path: path.join(root, '.qa/plugin-id-migration-failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
}).finally(async () => { if (browser) await browser.close(); });
