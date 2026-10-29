const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const base = 'http://127.0.0.1:6807';
const pluginName = 'PageScape';
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
let browser, page;
const report = { passed: [], errors: [] };

(async () => {
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, userAgent });
  const login = await (await context.request.post(base + '/api/system/loginAuth', { data: { authCode: 'child-cards-isolated-test' } })).json();
  assert.equal(login.code, 0);
  async function api(route, data = {}) {
    const response = await (await context.request.post(base + route, { data })).json();
    assert.equal(response.code, 0, `${route}: ${response.msg}`); return response.data;
  }
  const info = await api('/api/system/getWorkspaceInfo');
  assert.equal(path.resolve(info.workspaceDir).toLowerCase(), path.join(root, '.test-workspace').toLowerCase(), 'Refuse to touch a user workspace');
  if (!process.env.CHILD_CARDS_SKIP_INSTALL) {
    await api('/api/petal/setPetalEnabled', { packageName: pluginName, enabled: false });
    await fs.cp(path.join(root, 'dist'), path.join(root, '.test-workspace/data/plugins', pluginName), { recursive: true });
    await api('/api/petal/setPetalEnabled', { packageName: pluginName, enabled: true });
  }
  const stamp = Date.now();
  const notebook = (await api('/api/notebook/createNotebook', { name: 'Canvas Parity Controller QA ' + stamp })).notebook.id;
  const source = await api('/api/filetree/createDocWithMd', { notebook, path: '/原文编辑测试 ' + stamp, markdown: 'Original source paragraph ' + stamp });
  report.notebook = notebook; report.source = source;
  const sourceBefore = await api('/api/block/getBlockKramdown', { id: source });
  page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.siyuan?.ws?.app?.plugins?.some(p => p.name === 'PageScape'), undefined, { timeout: 60000 });
  await page.locator('[data-key="dialog-changelog"] .b3-dialog__scrim').click({ position: { x: 5, y: 5 }, timeout: 1000 }).catch(() => {});
  const originalId = await page.evaluate(async ({ notebook, source, stamp }) => {
    const plugin = window.siyuan.ws.app.plugins.find(p => p.name === 'PageScape');
    const scene = await plugin.canvasStore.create('Parity source ' + stamp, { notebook });
    scene.nodes = [
      { id: 'qa-source', kind: 'doc', docId: source, title: 'Source', x: 20, y: 20, width: 450, height: 350, color: 'blue' },
      { id: 'qa-convert', kind: 'text', text: '# Preserve Markdown ' + stamp + '\n\nUnique paragraph with **bold** and a second line.\n\n- one\n- two', x: 510, y: 20, width: 320, height: 250, color: 'orange' },
    ];
    const saved = await plugin.canvasStore.save(scene, scene.revision);
    await plugin.openCanvasDocument(saved.id); return saved.id;
  }, { notebook, source, stamp });
  report.original = originalId;
  await page.locator('.scv-root:visible').last().getByRole('button', { name: '更多工具', exact: true }).click();
  const state = () => page.evaluate(() => {
    const c = [...window.siyuan.ws.app.plugins.find(p => p.name === 'PageScape').canvases.values()].find(c => c.element.getClientRects().length);
    return { scene: c?.scene, dirty: c?.dirty, task: Boolean(c?.saveTask || c?.transitionTask) };
  });
  const saved = () => page.waitForFunction(() => {
    const c = [...window.siyuan.ws.app.plugins.find(p => p.name === 'PageScape').canvases.values()].find(c => c.element.getClientRects().length);
    return c?.scene && !c.dirty && !c.saveTask && !c.transitionTask;
  }, undefined, { timeout: 20000 });
  await saved();
  const pngBytes = [...await fs.readFile(path.join(root, 'icon.png'))];
  await page.evaluate(async bytes => {
    const c = [...window.siyuan.ws.app.plugins.find(p => p.name === 'PageScape').canvases.values()].find(c => c.element.getClientRects().length);
    await c.addMedia([new File([new Uint8Array(bytes)], 'parity-fixture.png', { type: 'image/png' })], { x: 100, y: 450 });
  }, pngBytes);
  await saved();
  const media = (await state()).scene.nodes.find(n => n.kind === 'file');
  assert.ok(media && media.file.startsWith('assets/'), 'media is stored as a native SiYuan asset');
  const canvasBlockId = (await api('/api/block/getChildBlocks', { id: originalId })).find(b => b.type === 'custom').id;
  const assetRefs = attrs => Object.entries(attrs).filter(([key]) => key.startsWith('custom-data-assets-scc-')).map(([, value]) => value).sort();
  assert.deepEqual(assetRefs(await api('/api/attr/getBlockAttrs', { id: canvasBlockId })), [media.file]);
  const actualAsset = await context.request.get(base + '/' + media.file);
  assert.ok(actualAsset.ok()); assert.deepEqual([...await actualAsset.body()], pngBytes, 'uploaded bytes are intact');
  assert.deepEqual(await api('/api/block/getBlockKramdown', { id: source }), sourceBefore, 'media upload does not change referenced notes');
  report.passed.push('native asset upload and exact-byte readback');
  const replacementBytes = [...Buffer.from(await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 32; c.height = 32;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#cb2040'; ctx.fillRect(0, 0, 32, 32);
    return c.toDataURL('image/png').split(',')[1];
  }), 'base64')];
  await api('/api/attr/setBlockAttrs', { id: canvasBlockId, attrs: { 'custom-parity-preserve': 'keep', 'custom-data-assets-other-plugin': media.file } });
  await page.evaluate(async ({ bytes, mediaId }) => {
    const c = [...window.siyuan.ws.app.plugins.find(p => p.name === 'PageScape').canvases.values()].find(c => c.element.getClientRects().length);
    c.change({ ...c.scene, edges: [{ id: 'media-reference', from: 'qa-source', to: mediaId, label: 'Preserve this edge', color: 'purple' }] });
    c.view.setScene(c.scene); await c.flush();
    await c.addMedia([new File([new Uint8Array(bytes)], 'replacement fixture.png', { type: 'image/png' })], undefined, mediaId);
  }, { bytes: replacementBytes, mediaId: media.id });
  await saved();
  const afterSwap = (await state()).scene;
  const replacement = afterSwap.nodes.find(n => n.id === media.id);
  assert.equal(afterSwap.nodes.filter(n => n.kind === 'file').length, 1);
  assert.equal(replacement.name, 'replacement fixture.png'); assert.equal(replacement.x, media.x); assert.equal(replacement.y, media.y);
  assert.equal(afterSwap.edges[0].to, media.id); assert.equal(afterSwap.edges[0].label, 'Preserve this edge');
  report.passed.push('media replacement keeps identity, layout and connections');
  let registered = await api('/api/attr/getBlockAttrs', { id: canvasBlockId });
  assert.deepEqual(assetRefs(registered), [replacement.file]); assert.equal(registered['custom-parity-preserve'], 'keep');
  assert.equal(registered['custom-data-assets-other-plugin'], media.file);
  await page.evaluate(async oldFile => {
    const c = [...window.siyuan.ws.app.plugins.find(p => p.name === 'PageScape').canvases.values()].find(c => c.element.getClientRects().length);
    c.change({ ...c.scene, nodes: [...c.scene.nodes,
      { id: 'asset-note', kind: 'text', text: `![asset](${oldFile})`, x: 1000, y: 20, width: 250, height: 200, color: 'neutral' },
      { id: 'asset-group', kind: 'group', title: 'Asset background', background: oldFile, x: 980, y: 0, width: 400, height: 320, color: 'neutral' },
    ] }); c.view.setScene(c.scene); await c.flush();
  }, media.file);
  registered = await api('/api/attr/getBlockAttrs', { id: canvasBlockId });
  assert.deepEqual(assetRefs(registered), [media.file, replacement.file].sort(), 'text and group media references are registered once');
  await page.evaluate(async () => {
    const c = [...window.siyuan.ws.app.plugins.find(p => p.name === 'PageScape').canvases.values()].find(c => c.element.getClientRects().length);
    c.change({ ...c.scene, nodes: c.scene.nodes.filter(n => !['asset-note', 'asset-group'].includes(n.id)) }); c.view.setScene(c.scene); await c.flush();
  });
  registered = await api('/api/attr/getBlockAttrs', { id: canvasBlockId });
  assert.deepEqual(assetRefs(registered), [replacement.file]); assert.equal(registered['custom-data-assets-other-plugin'], media.file);
  report.passed.push('native asset registration tracks text/background/replacement and preserves foreign attributes');
  const beforeFailure = (await state()).scene.nodes;
  await page.route('**/api/asset/upload', route => route.fulfill({ status: 500, body: 'fixture failure' }));
  await page.evaluate(async bytes => {
    const c = [...window.siyuan.ws.app.plugins.find(p => p.name === 'PageScape').canvases.values()].find(c => c.element.getClientRects().length);
    await c.addMedia([new File([new Uint8Array(bytes)], 'failed.png', { type: 'image/png' })]);
  }, pngBytes);
  await page.unroute('**/api/asset/upload');
  assert.deepEqual((await state()).scene.nodes, beforeFailure, 'failed upload preserves the scene');
  report.passed.push('failed media upload leaves nodes unchanged');

  // Enter through the actual card, then type with the established outer-editor focus.
  if (!process.env.CHILD_CARDS_SKIP_NATIVE) {
  const docCard = page.locator('.scv-root:visible [data-scv-node-id="qa-source"]');
  await docCard.locator('.scv-node-preview').dblclick();
  const editable = docCard.locator('.scv-native-editor .protyle-wysiwyg [contenteditable="true"]').first();
  await editable.waitFor({ timeout: 20000 }); await editable.click(); await page.keyboard.press('End');
  await page.keyboard.type(' Native edit saved ' + stamp, { delay: 20 });
  await docCard.getByRole('button', { name: '结束编辑', exact: true }).click();
  await page.evaluate(async () => {
    const c = [...window.siyuan.ws.app.plugins.find(p => p.name === 'PageScape').canvases.values()].find(c => c.element.getClientRects().length);
    await c.closeEditors();
  });
  let sourceSaved = false;
  const saveDeadline = Date.now() + 20000;
  while (Date.now() < saveDeadline) {
    if ((await api('/api/block/getBlockKramdown', { id: source })).kramdown.includes('Native edit saved ' + stamp)) { sourceSaved = true; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(sourceSaved, 'native editor transactions reach the kernel after immediate editor cleanup');
  assert.match((await api('/api/block/getBlockKramdown', { id: source })).kramdown, /Native edit saved/);
  report.passed.push('native inline editor persists explicit source edits');
  } else report.skipped = ['native editor is being independently diagnosed; this is a partial run'];

  await page.evaluate(() => {
    const c = [...window.siyuan.ws.app.plugins.find(p => p.name === 'PageScape').canvases.values()].find(c => c.element.getClientRects().length);
    window.__qaConvert = c.convertText('qa-convert');
  });
  const location = page.locator('.scv-destination:visible'); await location.waitFor();
  await location.getByLabel('画布名称').fill('Converted text ' + stamp);
  await location.getByLabel('保存到笔记本').selectOption(notebook);
  await location.getByRole('button', { name: '放在根目录', exact: true }).click();
  await location.getByRole('button', { name: '保存到这里', exact: true }).click();
  await page.evaluate(() => window.__qaConvert); await saved();
  const converted = (await state()).scene.nodes.find(n => n.id === 'qa-convert');
  assert.equal(converted.kind, 'doc'); assert.equal(converted.x, 510); assert.equal(converted.y, 20);
  const convertedBody = (await api('/api/block/getBlockKramdown', { id: converted.docId })).kramdown;
  assert.ok(convertedBody.includes('Preserve Markdown ' + stamp)); assert.ok(convertedBody.includes('Unique paragraph'));
  report.passed.push('text conversion creates a native note and preserves node identity/layout');
  const originalScene = (await state()).scene;
  const canvasFile = { nodes: [
    { id: 'A', type: 'text', text: 'Imported Markdown **preserved**', x: -20, y: 20, width: 300, height: 200, color: '1' },
    { id: 'B', type: 'file', file: media.file, x: 400, y: 20, width: 300, height: 240 },
    { id: 'C', type: 'link', url: 'https://obsidian.md', x: 20, y: 400, width: 350, height: 240 },
    { id: 'D', type: 'file', file: '../vault/missing-note.md', x: 900, y: 400, width: 350, height: 240 },
  ], edges: [
    { id: 'AB', fromNode: 'A', toNode: 'B', fromSide: 'right', toSide: 'left', fromEnd: 'arrow', toEnd: 'arrow', label: 'Both ways', color: '#123456' },
    { id: 'BD', fromNode: 'B', toNode: 'D', label: 'Keep imported relationship' },
  ], fixtureExtension: { text: 'keep me' } };
  await page.evaluate(file => {
    const c = [...window.siyuan.ws.app.plugins.find(p => p.name === 'PageScape').canvases.values()].find(c => c.element.getClientRects().length);
    window.__qaImport = c.importCanvas(new File([JSON.stringify(file)], 'Imported QA.canvas', { type: 'application/json' }));
  }, canvasFile);
  await location.waitFor(); await location.getByLabel('画布名称').fill('Imported exact title ' + stamp);
  await location.getByLabel('保存到笔记本').selectOption(notebook); await location.getByRole('button', { name: '保存到这里', exact: true }).click();
  await page.evaluate(() => window.__qaImport); await saved();
  let imported = (await state()).scene;
  assert.notEqual(imported.id, originalId); assert.equal(imported.title, 'Imported exact title ' + stamp);
  assert.equal(imported.nodes.length, 4); assert.equal(imported.edges.length, 2); assert.equal(imported.edges[0].fromEnd, 'arrow');
  assert.deepEqual(imported.jsonCanvas.fixtureExtension, { text: 'keep me' });
  const originalAfter = await page.evaluate(id => window.siyuan.ws.app.plugins.find(p => p.name === 'PageScape').canvasStore.load(id), originalId);
  assert.deepEqual(originalAfter.nodes, originalScene.nodes); assert.deepEqual(originalAfter.edges, originalScene.edges);
  report.passed.push('JSON Canvas import uses a new named document/tab and leaves source intact');
  await page.evaluate(() => {
    const c = [...window.siyuan.ws.app.plugins.find(p => p.name === 'PageScape').canvases.values()].find(c => c.element.getClientRects().length);
    window.__qaSwap = c.swapDocument('D');
  });
  const picker = page.locator('.scc-canvas-picker:visible'); await picker.waitFor();
  const search = picker.getByRole('searchbox', { name: '搜索思源文档' });
  await search.fill(converted.docId); await search.press('Enter');
  await picker.getByRole('button', { name: '替换为此文档', exact: true }).click();
  await page.evaluate(() => window.__qaSwap); await saved();
  imported = (await state()).scene;
  const associated = imported.nodes.find(n => n.id === 'D');
  assert.equal(associated.kind, 'doc'); assert.equal(associated.docId, converted.docId); assert.equal(associated.x, 900);
  assert.equal(imported.edges.find(e => e.id === 'BD').to, 'D');
  report.passed.push('unresolved Obsidian note associates with a native document without losing layout/edges');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.siyuan?.ws?.app?.plugins?.some(p => p.name === 'PageScape'), undefined, { timeout: 60000 });
  const loaded = await page.evaluate(id => window.siyuan.ws.app.plugins.find(p => p.name === 'PageScape').canvasStore.load(id), imported.id);
  assert.deepEqual(loaded.nodes, imported.nodes); assert.deepEqual(loaded.edges, imported.edges);
  report.passed.push('extended nodes and edge options survive document storage and reload');
  if (!process.env.CHILD_CARDS_SKIP_NATIVE) {
    const sourceInfo = await api('/api/block/getBlockInfo', { id: source });
    const nativeFile = path.join(root, '.test-workspace/data', sourceInfo.box, sourceInfo.path.replace(/^[/\\]+/, ''));
    assert.ok(nativeFile.startsWith(path.join(root, '.test-workspace/data') + path.sep));
    let persisted = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if ((await fs.readFile(nativeFile, 'utf8')).includes('Native edit saved ' + stamp)) { persisted = true; break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(persisted, 'explicit source editing reached the physical native note file');
    report.passed.push('source edits survive close and reach the physical .sy document');
  }
  report.notebook = notebook; report.original = originalId; report.imported = imported.id; report.converted = converted.docId;
  assert.deepEqual(report.errors, []);
  await fs.writeFile(path.join(root, '.qa/canvas-parity-controller.json'), JSON.stringify(report, null, 2));
  console.log('Canvas parity controller integration passed', report);
  await api('/api/notebook/closeNotebook', { notebook });
})().catch(async error => {
  report.failure = String(error.stack || error); console.error(error);
  if (page) await page.screenshot({ path: path.join(root, '.qa/canvas-parity-controller-failure.png') }).catch(() => {});
  await fs.writeFile(path.join(root, '.qa/canvas-parity-controller-failure.json'), JSON.stringify(report, null, 2)).catch(() => {});
  process.exitCode = 1;
}).finally(async () => { await browser?.close(); });
