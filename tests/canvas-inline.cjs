const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const base = 'http://127.0.0.1:6807';
const name = 'PageScape';
let browser, page;
const report = { passed: [], errors: [] };

(async () => {
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({ viewport: { width: 1640, height: 1200 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36' });
  const login = await (await context.request.post(base + '/api/system/loginAuth', { data: { authCode: 'child-cards-isolated-test' } })).json();
  assert.equal(login.code, 0);
  async function api(route, data = {}) {
    const response = await (await context.request.post(base + route, { data })).json();
    assert.equal(response.code, 0, `${route}: ${response.msg}`); return response.data;
  }
  assert.equal(path.resolve((await api('/api/system/getWorkspaceInfo')).workspaceDir).toLowerCase(), path.join(root, '.test-workspace').toLowerCase(), 'Never mutate a user workspace');
  await api('/api/setting/setBazaar', { trust: true, petalDisabled: false });
  await api('/api/petal/setPetalEnabled', { packageName: name, enabled: false });
  await fs.cp(path.join(root, 'dist'), path.join(root, '.test-workspace/data/plugins', name), { recursive: true });
  await api('/api/petal/setPetalEnabled', { packageName: name, enabled: true });
  const stamp = Date.now();
  const notebook = (await api('/api/notebook/createNotebook', { name: 'Inline Canvas QA ' + stamp })).notebook.id;
  const source = await api('/api/filetree/createDocWithMd', { notebook, path: '/引用原文 ' + stamp, markdown: '引用正文保持不变 ' + stamp });
  const sourceBefore = await api('/api/block/getBlockKramdown', { id: source });
  async function boot(target) {
    target.on('pageerror', error => report.errors.push(error.message));
    await target.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await target.waitForFunction(() => window.siyuan?.layout?.centerLayout && window.siyuan?.ws?.app?.plugins?.some(p => p.name === 'PageScape'), undefined, { timeout: 60000 });
    await target.locator('[data-key="dialog-changelog"] .b3-dialog__scrim').click({ position: { x: 5, y: 5 }, timeout: 1000 }).catch(() => {});
  }
  page = await context.newPage(); await boot(page);
  const documentId = await page.evaluate(async ({ notebook, source, stamp }) => {
    const plugin = window.siyuan.ws.app.plugins.find(p => p.name === 'PageScape');
    const scene = await plugin.canvasStore.create('正文画布测试 ' + stamp, { notebook });
    scene.viewport = { x: 30, y: 20, zoom: .8 };
    scene.nodes = [
      { id: 'text-a', kind: 'text', text: '第一张便签', x: 20, y: 20, width: 280, height: 220, color: 'blue' },
      { id: 'text-b', kind: 'text', text: '第二张便签', x: 410, y: 20, width: 260, height: 220, color: 'orange' },
      { id: 'doc-a', kind: 'doc', docId: source, title: '引用原文', x: 20, y: 290, width: 320, height: 220, color: 'green' },
    ];
    await plugin.canvasStore.save(scene, scene.revision); return scene.id;
  }, { notebook, source, stamp });
  report.documentId = documentId;
  await api('/api/block/prependBlock', { parentID: documentId, dataType: 'markdown', data: '画布前的普通正文 ' + stamp });
  await api('/api/block/appendBlock', { parentID: documentId, dataType: 'markdown', data: '画布后的普通正文 ' + stamp });
  const frame = () => page.locator(`.scv-inline[data-canvas-document="${documentId}"]:visible`);
  const inlineState = () => page.evaluate(id => {
    const plugin = window.siyuan.ws.app.plugins.find(p => p.name === 'PageScape');
    return [...plugin.inlineCanvases.values()].flatMap(m => [...m.values()]).find(v => v.controller.scene?.id === id)?.controller.scene;
  }, documentId);
  const saved = () => page.waitForFunction(id => {
    const plugin = window.siyuan.ws.app.plugins.find(p => p.name === 'PageScape');
    const c = [...plugin.inlineCanvases.values()].flatMap(m => [...m.values()]).find(v => v.controller.scene?.id === id)?.controller;
    return c?.scene && !c.dirty && !c.saveTask && !c.transitionTask;
  }, documentId, { timeout: 20000 });
  async function openDocument() {
    await page.evaluate(id => window.siyuan.ws.app.plugins.find(p => p.name === 'PageScape').openDocument(id), documentId);
    await frame().waitFor(); await saved();
  }
  async function persisted() {
    const block = (await api('/api/block/getChildBlocks', { id: documentId })).find(b => b.type === 'custom');
    const markdown = (await api('/api/block/getBlockKramdown', { id: block.id })).kramdown;
    return JSON.parse(markdown.split('\n').slice(1).join('\n').split('\n;;;')[0]).scene;
  }
  await openDocument();
  assert.equal(await frame().locator('.scv-root').count(), 1);
  assert.equal(await frame().locator('.scv-node').count(), 3);
  await frame().locator('[data-scv-node-id="doc-a"] .scv-node-preview').getByText('引用正文保持不变 ' + stamp, { exact: true }).waitFor();
  const stageBox = await frame().locator('.scv-stage').boundingBox();
  const docBox = await frame().locator('[data-scv-node-id="doc-a"]').boundingBox();
  report.inlineGeometry = await frame().evaluate(el => [...el.querySelectorAll('.scv-node')].map(n => ({ id: n.dataset.scvNodeId, position: getComputedStyle(n).position, rect: n.getBoundingClientRect().toJSON() })));
  assert.ok(docBox.y + docBox.height <= stageBox.y + stageBox.height + 2, JSON.stringify({ stageBox, docBox, cards: report.inlineGeometry }));
  await page.evaluate(id => {
    const plugin = window.siyuan.ws.app.plugins.find(p => p.name === 'PageScape');
    window.inlineOriginal = [...plugin.inlineCanvases.values()].flatMap(m => [...m.values()]).find(v => v.controller.scene?.id === id);
  }, documentId);
  const before = await inlineState();
  const head = frame().locator('[data-scv-node-id="text-a"] .scv-node-header');
  const box = await head.boundingBox(); assert.ok(box);
  await page.mouse.move(box.x + 65, box.y + 12); await page.mouse.down();
  await page.mouse.move(box.x + 145, box.y + 52, { steps: 8 }); await page.mouse.up();
  await saved();
  const moved = await persisted();
  assert.ok(moved.nodes[0].x > before.nodes[0].x + 50, 'Dragging in a document changes stored geometry');
  report.passed.push('inline pointer dragging and persistent geometry');

  const note = frame().locator('[data-scv-node-id="text-a"]');
  await note.getByRole('button', { name: '编辑便签', exact: true }).click();
  const textarea = note.locator('textarea');
  await textarea.fill('自动保存前输入 ' + stamp); await saved();
  assert.ok(await textarea.evaluate(el => document.activeElement === el), 'Autosave preserves textarea focus');
  await page.keyboard.type(' / 保存后继续输入'); await saved();
  assert.equal((await persisted()).nodes.find(n => n.id === 'text-a').text, '自动保存前输入 ' + stamp + ' / 保存后继续输入');
  assert.ok(await page.evaluate(() => [...window.siyuan.ws.app.plugins.find(p => p.name === 'PageScape').inlineCanvases.values()].some(m => [...m.values()].includes(window.inlineOriginal))), 'The same editor survives its own native rerender');
  await textarea.press('Escape');
  await frame().getByRole('button', { name: '连线', exact: true }).click();
  await frame().locator('[data-scv-node-id="text-a"] .scv-node-header').click();
  await frame().locator('[data-scv-node-id="text-b"] .scv-node-header').click(); await saved();
  assert.equal((await persisted()).edges.length, 1);
  await frame().locator('.scv-stage').press('Escape');
  report.passed.push('autosave focus and caret continuity', 'same controller across native rerenders', 'inline connections');

  await frame().getByLabel('画布高度', { exact: true }).evaluate(el => { el.value = '880'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.equal(Math.round((await frame().locator('.scv-inline-body').boundingBox()).height), 880);
  const viewport = (await inlineState()).viewport;
  await frame().locator('.scv-stage').hover({ position: { x: 700, y: 300 } });
  await page.mouse.wheel(0, 100);
  assert.deepEqual((await inlineState()).viewport, viewport, 'Ordinary wheel scrolls the document, not the canvas');
  await frame().locator('.scv-stage').hover({ position: { x: 700, y: 300 } });
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control');
  await page.waitForFunction(() => window.inlineOriginal.controller.scene.viewport.zoom > .8); await saved();
  report.passed.push('height adjustment', 'document wheel scrolling and canvas zoom');
  console.log('Inline dragging, focus continuity, connections, height and wheel behavior passed');

  await frame().getByRole('button', { name: '打开 Canvas', exact: true }).click();
  const standalone = () => page.locator('.scv-root:visible').filter({ has: page.locator('.scv-board-select:visible') });
  await standalone().waitFor();
  await standalone().getByRole('button', { name: '适应全部', exact: true }).click();
  const independentNote = standalone().locator('[data-scv-node-id="text-b"]');
  await independentNote.getByRole('button', { name: '编辑便签', exact: true }).click();
  await independentNote.locator('textarea').fill('独立视图保存 ' + stamp);
  await page.waitForFunction(id => [...window.siyuan.ws.app.plugins.find(p => p.name === 'PageScape').canvases.values()].some(c => c.scene?.id === id && !c.dirty && !c.saveTask), documentId);
  await standalone().getByRole('button', { name: '打开所属文档', exact: true }).click();
  await frame().waitFor(); await saved();
  await page.waitForFunction(id => [...window.siyuan.ws.app.plugins.find(p => p.name === 'PageScape').inlineCanvases.values()].some(m => [...m.values()].some(v => v.controller.scene?.id === id && v.controller.scene.nodes.some(n => n.text?.startsWith('独立视图保存')))), documentId);
  report.passed.push('shared document data with standalone editor');
  await frame().getByRole('button', { name: '适应全部', exact: true }).click(); await saved();

  let blocked = false;
  await page.route('**/api/block/updateBlock', route => { blocked = true; return route.abort('failed'); });
  await frame().locator('[data-scv-node-id="text-a"]').getByRole('button', { name: '编辑便签', exact: true }).click();
  await frame().locator('[data-scv-node-id="text-a"] textarea').fill('保存失败后仍保留的草稿 ' + stamp);
  await frame().locator('.scv-status').filter({ hasText: '保存失败' }).waitFor(); assert.ok(blocked);
  assert.ok(!(await persisted()).nodes.find(n => n.id === 'text-a').text.includes('保存失败后'));
  await page.unroute('**/api/block/updateBlock');
  await frame().getByRole('button', { name: '保存', exact: true }).click(); await saved();
  assert.equal((await persisted()).nodes.find(n => n.id === 'text-a').text, '保存失败后仍保留的草稿 ' + stamp);
  report.passed.push('failed save retains draft and manual retry succeeds');

  await frame().getByRole('button', { name: '更多工具', exact: true }).click();
  await frame().getByRole('button', { name: '另存副本', exact: true }).click();
  const destination = page.locator('.scv-destination:visible'); await destination.waitFor();
  await destination.getByLabel('保存到笔记本').selectOption(notebook);
  await destination.getByRole('button', { name: '保存到这里', exact: true }).click();
  await page.waitForFunction(id => [...window.siyuan.ws.app.plugins.find(p => p.name === 'PageScape').canvases.values()].some(c => c.element.getClientRects().length && c.scene?.id && c.scene.id !== id && !c.dirty && !c.saveTask), documentId);
  assert.equal((await inlineState()).id, documentId, 'Save-copy cannot retarget a document block to its new copy');
  await openDocument();
  await frame().locator('.scv-stage').press('Control+a');
  await frame().locator('.scv-stage').press('Delete'); await saved();
  assert.equal((await persisted()).nodes.length, 0);
  await frame().locator('.scv-stage').press('Control+z'); await saved();
  assert.equal((await persisted()).nodes.length, 3);
  assert.equal((await persisted()).edges.length, 1);
  report.passed.push('save-copy opens independent copy without retargeting document', 'canvas delete and undo do not delete the containing block');

  await page.reload(); await page.waitForFunction(() => window.siyuan?.layout?.centerLayout && window.siyuan?.ws?.app?.plugins?.some(p => p.name === 'PageScape'));
  await openDocument();
  assert.equal(await frame().getByLabel('画布高度', { exact: true }).inputValue(), '880');
  assert.equal((await inlineState()).edges.length, 1);
  assert.equal((await inlineState()).nodes.find(n => n.id === 'text-a').text, '保存失败后仍保留的草稿 ' + stamp);
  const blocks = await api('/api/block/getChildBlocks', { id: documentId });
  assert.equal(blocks.filter(b => b.type === 'custom').length, 1);
  assert.ok(blocks.some(b => b.content === '画布前的普通正文 ' + stamp));
  assert.ok(blocks.some(b => b.content === '画布后的普通正文 ' + stamp));
  assert.deepEqual(await api('/api/block/getBlockKramdown', { id: source }), sourceBefore);
  assert.equal(await frame().locator('.protyle').count(), 0);
  assert.equal(await frame().locator('.scv-node').count(), 3);
  await frame().getByRole('button', { name: '适应全部', exact: true }).click(); await saved();
  await frame().locator('[data-scv-node-id="doc-a"] .scv-node-preview').getByText('引用正文保持不变 ' + stamp, { exact: true }).waitFor();
  report.passed.push('reload preserves layout text edges and height', 'surrounding body and referenced document unchanged', 'no nested native editor');
  await page.screenshot({ path: path.join(root, '.qa/canvas-inline.png'), fullPage: true });
  await api('/api/petal/setPetalEnabled', { packageName: name, enabled: false });
  await page.waitForFunction(() => !document.querySelector('.scv-root,.scv-inline'));
  report.passed.push('plugin unload cleans up inline and standalone editors');
  assert.deepEqual(report.errors.filter(e => /child-cards|Canvas|scv-|Cannot read properties/.test(e)), []);
  await fs.writeFile(path.join(root, '.qa/canvas-inline-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); await browser.close();
})().catch(async error => {
  console.error(error);
  if (page) {
    await page.screenshot({ path: path.join(root, '.qa/canvas-inline-failure.png'), fullPage: true }).catch(() => {});
    console.error(await page.evaluate(() => document.body.innerText.slice(-1800)).catch(() => 'no page'));
  }
  await browser?.close().catch(() => {}); process.exitCode = 1;
});
