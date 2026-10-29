const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const base = 'http://127.0.0.1:6807';
const storage = path.join(root, '.test-workspace/data/storage/petal/siyuan-child-cards');
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
let browser, page;

(async () => {
  await fs.mkdir(path.join(root, '.qa'), { recursive: true });
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1050 }, userAgent });
  assert.equal((await (await context.request.post(base + '/api/system/loginAuth', { data: { authCode: 'child-cards-isolated-test' } })).json()).code, 0);
  async function api(route, data = {}) {
    const result = await (await context.request.post(base + route, { data })).json();
    assert.equal(result.code, 0, `${route}: ${result.msg}`); return result.data;
  }
  const workspace = await api('/api/system/getWorkspaceInfo');
  assert.equal(path.resolve(workspace.workspaceDir).toLowerCase(), path.join(root, '.test-workspace').toLowerCase(), 'Refuse to mutate a user workspace');
  await api('/api/setting/setBazaar', { trust: true, petalDisabled: false });
  await api('/api/petal/setPetalEnabled', { packageName: 'siyuan-child-cards', enabled: false });
  await fs.cp(path.join(root, 'dist'), path.join(root, '.test-workspace/data/plugins/siyuan-child-cards'), { recursive: true });
  const archive = path.resolve(root, '.qa', 'canvas-document-test-storage-' + Date.now());
  assert.ok(storage.startsWith(root + path.sep) && archive.startsWith(root + path.sep), 'archive stays inside the isolated project');
  await fs.rename(storage, archive).catch(error => { if (error.code !== 'ENOENT') throw error; });
  // Existing test JSON remains intact; add a recoverable orphan to exercise directory discovery.
  const token = Date.now(); const legacyId = crypto.randomUUID();
  const notebook = (await api('/api/notebook/createNotebook', { name: 'Canvas Documents QA ' + token })).notebook.id;
  const parent = await api('/api/filetree/createDocWithMd', { notebook, path: '/画布文档测试 ' + token, markdown: '保存位置父文档正文。' });
  const movedParent = await api('/api/filetree/createDocWithMd', { notebook, path: '/移动后的目录 ' + token, markdown: '第二个保存位置。' });
  const source = await api('/api/filetree/createDocWithMd', { notebook, path: '/引用文档 ' + token, markdown: '引用正文保留。\n\n```cpp\nField<scalar> values(10, 0);\n```\n\n$$\n\\nabla \\cdot U=0\n$$' });
  const sourceBefore = await api('/api/block/getBlockKramdown', { id: source });
  const legacy = { version: 1, id: legacyId, title: '迁移画布 ' + token, revision: crypto.randomUUID(), updatedAt: Date.now(),
    viewport: { x: 120, y: 80, zoom: .9 }, nodes: [
      { id: 'doc-one', kind: 'doc', docId: source, title: '引用文档', x: 10, y: 20, width: 320, height: 270, color: 'blue', groupId: 'group-one' },
      { id: 'text-one', kind: 'text', text: '需要完整保留的便签\n;;;\n中文与 emoji 🧭', x: 440, y: 20, width: 300, height: 230, color: 'orange', groupId: 'group-one' },
      { id: 'group-one', kind: 'group', title: '推导', x: -20, y: -30, width: 790, height: 350, color: 'green' },
    ], edges: [{ id: 'edge-one', from: 'doc-one', to: 'text-one', label: '推导关系', color: 'purple' }] };
  await fs.mkdir(storage, { recursive: true });
  await fs.writeFile(path.join(storage, 'canvas-' + legacyId + '.json'), '\uFEFF' + JSON.stringify(legacy, null, 2) + '\r\n');
  const indexed = { ...legacy, id: crypto.randomUUID(), title: '索引画布 ' + token, nodes: [], edges: [] };
  await fs.writeFile(path.join(storage, 'canvas-' + indexed.id + '.json'), JSON.stringify(indexed));
  await fs.writeFile(path.join(storage, 'canvas-index.json'), JSON.stringify({ version: 1, boards: [{ id: indexed.id, title: indexed.title, updatedAt: indexed.updatedAt }] }));
  const originals = new Map();
  for (const name of await fs.readdir(storage)) if (/^canvas-[a-z0-9_-]+\.json$/.test(name) && name !== 'canvas-migration.json') originals.set(name, await fs.readFile(path.join(storage, name)));
  await api('/api/petal/setPetalEnabled', { packageName: 'siyuan-child-cards', enabled: true });
  const errors = [];
  async function boot(target) {
    target.on('pageerror', e => errors.push(e.message));
    await target.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await target.waitForFunction(() => window.siyuan?.layout?.centerLayout && window.siyuan.ws?.app?.plugins?.some(p => p.name === 'siyuan-child-cards'), { timeout: 60000 });
    await target.locator('[data-key="dialog-changelog"] .b3-dialog__scrim').click({ position: { x: 5, y: 5 }, timeout: 2000 }).catch(() => {});
    await target.locator('#message .b3-snackbar__close').first().click({ timeout: 3000 }).catch(() => {});
  }
  page = await context.newPage(); await boot(page);
  await page.evaluate(async () => window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').openCanvas());
  const canvas = () => page.locator('.scv-root:visible').last();
  async function editNote(value) {
    const card = canvas().locator('.scv-node-text').first();
    await card.getByRole('button', { name: '编辑便签', exact: true }).click();
    await card.getByRole('textbox', { name: '便签内容', exact: true }).fill(value);
  }
  const scene = () => page.evaluate(() => [...window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').canvases.values()].find(c => c.element.getClientRects().length)?.scene);
  const saved = () => page.waitForFunction(() => {
    const plugin = window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards');
    const c = [...plugin.canvases.values()].find(c => c.element.getClientRects().length);
    return c?.scene && !plugin.creationTask && !c.dirty && !c.saveTask && !c.transitionTask;
  }, { timeout: 20000 });
  async function selectLocation(parentId) {
    const dialog = page.locator('.scv-destination:visible'); await dialog.waitFor();
    await dialog.getByLabel('保存到笔记本').selectOption(notebook);
    if (parentId) {
      await dialog.getByRole('button', { name: '选择父文档', exact: true }).click();
      const picker = page.locator('.scc-canvas-picker:visible');
      await picker.getByRole('searchbox', { name: '搜索思源文档' }).fill(parentId);
      await picker.getByRole('searchbox', { name: '搜索思源文档' }).press('Enter');
      await picker.getByRole('button', { name: '选择父文档', exact: true }).click();
    }
    await dialog.getByRole('button', { name: '保存到这里', exact: true }).click();
  }
  await canvas().getByRole('button', { name: '更多工具', exact: true }).click();
  await canvas().getByRole('button', { name: '迁移旧画布…', exact: true }).click(); await selectLocation(parent);
  await canvas().locator('.scv-status').filter({ hasText: '旧画布已迁移为思源文档' }).waitFor({ timeout: 60000 });
  const manifest = JSON.parse(await fs.readFile(path.join(storage, 'canvas-migration.json'), 'utf8'));
  assert.equal(manifest.stage, 'complete'); assert.ok(manifest.mapping[legacyId]);
  const documentId = manifest.mapping[legacyId];
  for (const [name, bytes] of originals) {
    assert.deepEqual(await fs.readFile(path.join(storage, name)), bytes, 'legacy original untouched');
    const backup = await fs.readFile(path.join(storage, 'canvas-backups', manifest.runId, name));
    assert.deepEqual(backup, bytes, 'byte-identical verified backup');
    assert.equal(manifest.files.find(f => f.name === name).sha256, digest(bytes));
  }
  await page.evaluate(async documentId => window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').openCanvasDocument(documentId), documentId);
  await saved(); const migrated = await scene();
  assert.equal(migrated.id, documentId); assert.deepEqual(migrated.nodes, legacy.nodes); assert.deepEqual(migrated.edges, legacy.edges); assert.deepEqual(migrated.viewport, legacy.viewport);
  assert.match(documentId, /^\d{14}-[a-z0-9]{7}$/);
  const info = await api('/api/block/getBlockInfo', { id: documentId });
  assert.ok(info.path.includes('/' + parent + '/'), 'migration used the requested parent document');
  const repeat = await page.evaluate(async notebook => window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').migrateCanvases({ notebook }), notebook);
  assert.deepEqual(repeat.mapping, manifest.mapping, 'migration is idempotent');
  console.log('Migration, exact backups, requested location and idempotence passed', { count: manifest.boards.length, documentId });

  await canvas().getByRole('button', { name: '适应全部', exact: true }).click();
  await canvas().locator('.katex').waitFor({ timeout: 15000 }); await saved();
  await editNote('文档中保存的编辑'); await saved();
  const firstBlocks = await api('/api/block/getChildBlocks', { id: documentId }); const canvasBlock = firstBlocks.find(b => b.type === 'custom'); assert.ok(canvasBlock);
  const savedMarkdown = await api('/api/block/getBlockKramdown', { id: canvasBlock.id }); assert.ok(savedMarkdown.kramdown.includes('文档中保存的编辑'));
  assert.equal((await api('/api/block/getChildBlocks', { id: documentId })).filter(b => b.type === 'custom').length, 1, 'save preserves one custom block');
  assert.deepEqual(await api('/api/block/getBlockKramdown', { id: source }), sourceBefore, 'source document unchanged');
  await canvas().getByRole('button', { name: '打开所属文档', exact: true }).click();
  await page.locator('.protyle:visible .scv-doc-card').waitFor();
  await page.locator('.protyle:visible .scv-doc-card').getByRole('button', { name: '打开 Canvas', exact: true }).click(); await saved();
  assert.equal((await scene()).id, documentId);
  await api('/api/filetree/renameDocByID', { id: documentId, title: '文档树改名 ' + token });
  await page.waitForFunction(title => [...window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').canvases.values()].some(c => c.scene?.title === title), '文档树改名 ' + token);
  await api('/api/filetree/moveDocsByID', { fromIDs: [documentId], toID: movedParent });
  await editNote('移动后继续编辑'); await saved();
  assert.ok((await api('/api/block/getBlockInfo', { id: documentId })).path.includes('/' + movedParent + '/'));

  // Copy using native document duplication; each root ID must own an independent canvas.
  const duplicated = await api('/api/filetree/duplicateDoc', { id: documentId });
  await page.evaluate(async docId => window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').openCanvasDocument(docId), duplicated.id); await saved();
  assert.equal((await scene()).id, duplicated.id);
  await editNote('原生副本文字'); await saved();
  assert.ok((await api('/api/block/getBlockKramdown', { id: canvasBlock.id })).kramdown.includes('移动后继续编辑'), 'native copy does not write original canvas');
  await page.evaluate(async docId => window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').openCanvasDocument(docId), documentId); await saved();
  assert.equal(await canvas().locator('textarea.scv-note-text').inputValue(), '移动后继续编辑');

  // Simulate restoring a document-history snapshot through the same native block API.
  await api('/api/block/updateBlock', { id: canvasBlock.id, dataType: 'markdown', data: savedMarkdown.kramdown });
  await page.waitForFunction(() => [...document.querySelectorAll('.scv-root textarea')].some(n => n.value === '文档中保存的编辑'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.siyuan?.layout?.centerLayout && window.siyuan.ws?.app?.plugins?.some(p => p.name === 'siyuan-child-cards'), { timeout: 60000 });
  await page.locator('#message .b3-snackbar__close').first().click({ timeout: 3000 }).catch(() => {});
  await page.evaluate(async docId => window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').openCanvasDocument(docId), documentId); await saved();
  assert.equal(await canvas().locator('textarea.scv-note-text').inputValue(), '文档中保存的编辑');
  console.log('Document body, native rename/move/copy, history snapshot and reload passed');

  await canvas().getByRole('button', { name: '新建', exact: true }).click();
  await page.locator('.scv-destination:visible').getByRole('button', { name: '取消', exact: true }).click(); assert.equal((await scene()).id, documentId);
  await canvas().getByRole('button', { name: '新建', exact: true }).click(); await selectLocation(parent); await saved();
  const newId = (await scene()).id; assert.notEqual(newId, documentId);
  assert.ok((await api('/api/block/getBlockInfo', { id: newId })).path.includes('/' + parent + '/'));
  await page.evaluate(async docId => window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').openCanvasDocument(docId), documentId); await saved();
  await canvas().getByRole('button', { name: '另存副本', exact: true }).click(); await selectLocation(movedParent);
  await page.waitForFunction(id => {
    const c = [...window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').canvases.values()].find(c => c.element.getClientRects().length);
    return c?.scene && c.scene.id !== id && !c.transitionTask;
  }, documentId);
  const copyId = (await scene()).id;
  assert.ok((await api('/api/block/getBlockInfo', { id: copyId })).path.includes('/' + movedParent + '/'));
  await page.screenshot({ path: path.join(root, '.qa/canvas-documents.png'), fullPage: true });
  await api('/api/petal/setPetalEnabled', { packageName: 'siyuan-child-cards', enabled: false });
  await page.waitForFunction(() => !window.siyuan.ws.app.plugins.some(p => p.name === 'siyuan-child-cards'), { timeout: 15000 });
  assert.equal(await page.locator('.scv-root,.scv-doc-card').count(), 0);
  const pluginErrors = errors.filter(e => /Canvas|scv-|child-cards|Cannot read properties/.test(e)); assert.deepEqual(pluginErrors, []);
  await fs.writeFile(path.join(root, '.qa/canvas-documents-integration.json'), JSON.stringify({ notebook, parent, documentId, copyId, newId, manifest, errors, passed: ['migration UI', 'byte-identical originals and backups', 'orphan canvas discovery', 'idempotent migration', 'selected parent', 'document block content', 'source unchanged', 'open from document', 'native rename and move', 'native duplicate independence', 'history snapshot restore', 'reload', 'new location and cancel', 'save copy location', 'disable cleanup'] }, null, 2));
  console.log('Canvas document integration passed', { documentId, copyId, newId, errors }); await browser.close();
})().catch(async error => {
  console.error(error); if (page) {
    await page.screenshot({ path: path.join(root, '.qa/canvas-documents-failure.png'), fullPage: true }).catch(() => {});
    console.error(await page.evaluate(() => document.body.innerText.slice(-3000)).catch(() => 'no state'));
  }
  await browser?.close().catch(() => {}); process.exit(1);
});
