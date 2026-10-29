const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const base = 'http://127.0.0.1:6807';
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
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
  assert.equal(path.resolve(workspace.workspaceDir).toLowerCase(), path.join(root, '.test-workspace').toLowerCase(), 'Only isolated workspace may be mutated');
  await api('/api/setting/setBazaar', { trust: true, petalDisabled: false });
  await api('/api/petal/setPetalEnabled', { packageName: 'siyuan-child-cards', enabled: false });
  await fs.cp(path.join(root, 'dist'), path.join(root, '.test-workspace/data/plugins/siyuan-child-cards'), { recursive: true });
  await api('/api/petal/setPetalEnabled', { packageName: 'siyuan-child-cards', enabled: true });
  const token = Date.now();
  const notebook = (await api('/api/notebook/createNotebook', { name: 'Canvas QA ' + token })).notebook.id;
  const parent = await api('/api/filetree/createDocWithMd', { notebook, path: '/Canvas ' + token, markdown: '父文档正文保留。' });
  const docs = [];
  for (const [name, markdown] of [['01 基础结构', '数据结构预览。\n\n```cpp\nField<scalar> values(10, 0.0);\n```'], ['02 场运算', '有限体积算子与场运算。\n\n$$\n\\nabla \\cdot U=0\n$$'], ['03 网格', '网格几何预览。']]) {
    docs.push(await api('/api/filetree/createDocWithMd', { notebook, path: '/Canvas ' + token + '/' + name, markdown }));
  }
  const extra = await api('/api/filetree/createDocWithMd', { notebook, path: '/拖入文档 ' + token, markdown: '通过文档树拖放加入的卡片。' });
  const originalParent = await api('/api/block/getBlockKramdown', { id: parent });
  const errors = [];
  async function boot(target) {
    target.on('pageerror', e => errors.push(e.message));
    await target.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await target.waitForFunction(() => window.siyuan?.layout?.centerLayout && window.siyuan.ws?.app?.plugins?.some(p => p.name === 'siyuan-child-cards'), { timeout: 60000 });
    await target.locator('[data-key="dialog-changelog"] .b3-dialog__scrim').click({ position: { x: 5, y: 5 }, timeout: 5000 }).catch(() => {});
    await target.locator('#message .b3-snackbar__close').first().click({ timeout: 3000 }).catch(() => {});
  }
  page = await context.newPage(); await boot(page);
  await page.evaluate(async parent => {
    const plugin = window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards');
    await plugin.openCanvas(parent);
  }, parent);
  const canvas = () => page.locator('.scv-root:visible').last();
  const scene = () => page.evaluate(() => {
    const plugin = window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards');
    return [...plugin.canvases.values()].find(c => c.element.getClientRects().length)?.scene;
  });
  async function saved(target = page) {
    await target.locator('.scv-root:visible .scv-status').filter({ hasText: /^已保存$/ }).waitFor({ timeout: 15000 });
  }
  await canvas().waitFor(); await saved();
  console.log('Native canvas tab ready');
  const oldId = (await scene()).id;
  await canvas().getByRole('button', { name: '新建', exact: true }).click();
  await page.waitForFunction(old => [...window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').canvases.values()].some(c => c.scene && c.scene.id !== old), oldId);
  await saved();
  await canvas().getByRole('button', { name: '重命名', exact: true }).click();
  await canvas().getByRole('textbox', { name: '画布名称', exact: true }).fill('OpenFOAM Canvas ' + token);
  await canvas().getByRole('button', { name: '确定', exact: true }).click(); await saved();
  await page.evaluate(async parent => {
    const c = [...window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').canvases.values()].find(c => c.element.getClientRects().length);
    await c.importChildren(parent);
  }, parent);
  await canvas().locator('.scv-node-doc').nth(2).waitFor();
  await canvas().getByRole('button', { name: '适应全部', exact: true }).click();
  await canvas().getByText('数据结构预览。', { exact: true }).waitFor();
  await canvas().locator('.katex').waitFor({ timeout: 15000 }); await saved();
  assert.equal(await canvas().locator('pre code').count(), 1);
  assert.equal(await canvas().locator('[contenteditable="true"]').count(), 0, 'source previews are readonly');
  console.log('Imported cards and real code/formula previews ready');
  const first = canvas().locator('.scv-node-doc').nth(0);
  const firstNode = await first.getAttribute('data-scv-node-id');
  const before = (await scene()).nodes.find(n => n.id === firstNode);
  const head = await first.locator('.scv-node-header').boundingBox();
  await page.mouse.move(head.x + 80, head.y + 18); await page.mouse.down();
  await page.mouse.move(head.x + 160, head.y + 73, { steps: 8 }); await page.mouse.up(); await saved();
  assert.notEqual((await scene()).nodes.find(n => n.id === firstNode).x, before.x);
  await canvas().getByRole('button', { name: '撤销', exact: true }).click();
  assert.equal((await scene()).nodes.find(n => n.id === firstNode).x, before.x);
  await canvas().getByRole('button', { name: '重做', exact: true }).click(); await saved();
  const resize = await first.locator('.scv-node-resize').boundingBox();
  const priorWidth = (await scene()).nodes.find(n => n.id === firstNode).width;
  await page.mouse.move(resize.x + 8, resize.y + 8); await page.mouse.down();
  await page.mouse.move(resize.x + 68, resize.y + 48, { steps: 6 }); await page.mouse.up(); await saved();
  assert.ok((await scene()).nodes.find(n => n.id === firstNode).width > priorWidth);
  await canvas().getByRole('button', { name: '连线', exact: true }).click();
  await canvas().locator('.scv-node-doc .scv-node-header').nth(0).click();
  await canvas().locator('.scv-node-doc .scv-node-header').nth(1).click();
  await canvas().getByRole('button', { name: '连线', exact: true }).click();
  assert.equal((await scene()).edges.length, 1); await saved();
  await canvas().locator('.scv-node-doc .scv-node-header').nth(0).click();
  await canvas().locator('.scv-node-doc .scv-node-header').nth(1).click({ modifiers: ['Shift'] });
  await canvas().getByRole('button', { name: '分组', exact: true }).click();
  assert.equal((await scene()).nodes.filter(n => n.groupId).length, 2);
  await canvas().getByRole('button', { name: '添加便签', exact: true }).click();
  await canvas().getByRole('textbox', { name: '便签内容' }).fill('本地推导与思路');
  await canvas().getByRole('button', { name: '适应全部', exact: true }).click(); await saved();
  const stage = await canvas().locator('.scv-stage').boundingBox();
  const hostDrops = await canvas().locator('.scv-stage').evaluate((element, { extra, x, y }) => {
    let count = 0; const listener = () => { count++; }; document.addEventListener('drop', listener);
    const dataTransfer = new DataTransfer(); dataTransfer.setData('application/siyuan-documents', JSON.stringify({ ids: [extra] }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX: x, clientY: y }));
    document.removeEventListener('drop', listener); return count;
  }, { extra, x: stage.x + 100, y: stage.y + 110 });
  assert.equal(hostDrops, 0, 'owned document drops do not reach native editor/tree handlers');
  await canvas().locator('.scv-node-doc').nth(3).waitFor(); await saved();
  console.log('Drag/resize/history/edges/groups/text/document drop passed');
  const initial = await scene(); const initialId = initial.id;
  const layoutBefore = initial.nodes.map(n => ({ id: n.id, x: n.x, y: n.y, width: n.width, height: n.height }));
  const block = (await api('/api/block/getChildBlocks', { id: docs[0] }))[0].id;
  const update = '原文自动更新 ' + token;
  const started = Date.now(); await api('/api/block/updateBlock', { id: block, dataType: 'markdown', data: update });
  await canvas().getByText(update, { exact: true }).waitFor({ timeout: 12000 });
  const refreshMs = Date.now() - started;
  assert.deepEqual((await scene()).nodes.map(n => ({ id: n.id, x: n.x, y: n.y, width: n.width, height: n.height })), layoutBefore, 'source refresh preserves layout');
  assert.deepEqual(await api('/api/block/getBlockKramdown', { id: parent }), originalParent, 'canvas does not write parent document');
  await canvas().getByRole('button', { name: '适应全部', exact: true }).click(); await saved();
  const persisted = await scene();
  await page.screenshot({ path: path.join(root, '.qa/canvas-actual-siyuan.png'), fullPage: true });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.siyuan?.layout?.centerLayout && window.siyuan.ws?.app?.plugins?.some(p => p.name === 'siyuan-child-cards'), { timeout: 60000 });
  await page.locator('[data-key="dialog-changelog"] .b3-dialog__scrim').click({ position: { x: 5, y: 5 }, timeout: 5000 }).catch(() => {});
  await page.locator('#message .b3-snackbar__close').first().click({ timeout: 3000 }).catch(() => {});
  await page.evaluate(async () => window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').openCanvas());
  await saved();
  assert.equal((await scene()).id, initialId); assert.deepEqual((await scene()).nodes, persisted.nodes);
  assert.deepEqual((await scene()).edges, persisted.edges); assert.deepEqual((await scene()).viewport, persisted.viewport);

  // A failed write retains the local draft. Another browser then saves a newer revision.
  await page.route('**/api/file/putFile', route => route.abort('failed'));
  await canvas().getByRole('textbox', { name: '便签内容' }).fill('必须保留的本地改动');
  await canvas().locator('.scv-status').filter({ hasText: '保存失败' }).waitFor({ timeout: 15000 });
  console.log('Live refresh and reload persistence passed');
  const secondContext = await browser.newContext({ viewport: { width: 1500, height: 1050 }, storageState: await context.storageState(), userAgent });
  const second = await secondContext.newPage(); await boot(second);
  await second.evaluate(async () => window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').openCanvas()); await saved(second);
  await second.locator('.scv-root:visible').getByRole('textbox', { name: '便签内容' }).fill('另一窗口的新版本'); await saved(second);
  await page.unroute('**/api/file/putFile');
  await canvas().getByRole('button', { name: '保存', exact: true }).click();
  await canvas().locator('.scv-status[data-tone="conflict"]').waitFor({ timeout: 15000 });
  assert.equal(await canvas().getByRole('textbox', { name: '便签内容' }).inputValue(), '必须保留的本地改动');
  await canvas().getByRole('button', { name: '另存副本', exact: true }).click();
  await page.waitForFunction(id => [...window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').canvases.values()].some(c => c.scene && c.scene.id !== id), initialId);
  const copy = await scene(); assert.equal(copy.nodes.find(n => n.kind === 'text').text, '必须保留的本地改动');
  const disk = await (await context.request.post(base + '/api/file/getFile', { data: { path: '/data/storage/petal/siyuan-child-cards/canvas-' + initialId + '.json' } })).json();
  assert.equal(disk.nodes.find(n => n.kind === 'text').text, '另一窗口的新版本');
  await secondContext.close();
  await api('/api/petal/setPetalEnabled', { packageName: 'siyuan-child-cards', enabled: false });
  await page.waitForFunction(() => !window.siyuan.ws.app.plugins.some(p => p.name === 'siyuan-child-cards'), { timeout: 15000 });
  assert.equal(await page.locator('.scv-root').count(), 0, 'disable releases canvas UI');
  const pluginErrors = errors.filter(e => /Canvas|scv-|child-cards|Cannot read properties/.test(e)); assert.deepEqual(pluginErrors, []);
  await fs.writeFile(path.join(root, '.qa/canvas-integration.json'), JSON.stringify({ initialId, copyId: copy.id, parent, docs, extra, refreshMs, errors, passed: ['independent native tab', 'import children', 'readonly code/formula preview', 'drag and resize', 'undo and redo', 'connect', 'group', 'text', 'native document drop', 'live source refresh preserves layout', 'parent unchanged', 'reload persistence', 'failed write preserves draft', 'second browser conflict', 'save copy preserves both', 'disable cleanup'] }, null, 2));
  console.log('Canvas integration passed', JSON.stringify({ initialId, refreshMs, copyId: copy.id, errors }));
  await browser.close();
})().catch(async error => {
  console.error(error);
  if (page) {
    await page.screenshot({ path: path.join(root, '.qa/canvas-failure.png'), fullPage: true }).catch(() => {});
    console.error(await page.evaluate(() => document.body.innerText.slice(-2400)).catch(() => 'no state'));
  }
  await browser?.close().catch(() => {}); process.exit(1);
});
