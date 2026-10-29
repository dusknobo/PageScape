const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const workspace = path.join(root, '.test-workspace');
const base = 'http://127.0.0.1:6807';
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const pluginName = 'siyuan-child-cards';
const output = path.join(root, '.qa/canvas-documents-safety.json');
const report = { kernel: undefined, workspace, copies: {}, passed: [], pageErrors: [] };
let browser;

function body(scene) { return { nodes: scene.nodes, edges: scene.edges, viewport: scene.viewport }; }
function text(scene) { return scene.nodes.find(node => node.kind === 'text')?.text; }

(async () => {
  const fixture = JSON.parse(await fs.readFile(path.join(root, '.qa/canvas-documents-integration.json'), 'utf8'));
  for (const id of [fixture.documentId, fixture.copyId, fixture.notebook]) assert.match(id, /^\d{14}-[a-z0-9]{7}$/);
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1050 }, userAgent });
  let response = await context.request.post(base + '/api/system/loginAuth', { data: { authCode: 'child-cards-isolated-test' } });
  assert.equal((await response.json()).code, 0);
  async function raw(route, data = {}) {
    assert.ok(base.endsWith(':6807'), 'test can only access the isolated port');
    const response = await context.request.post(base + route, { data });
    assert.ok(response.ok(), `${route}: HTTP ${response.status()}`);
    return response.json();
  }
  async function api(route, data = {}) {
    const response = await raw(route, data);
    assert.equal(response.code, 0, `${route}: ${response.msg}`);
    return response.data;
  }
  const info = await api('/api/system/getWorkspaceInfo');
  assert.equal(path.resolve(info.workspaceDir).toLowerCase(), workspace.toLowerCase(), 'Refuse to mutate a user workspace');
  report.kernel = info.siyuanVer;
  const notebook = (await api('/api/notebook/lsNotebooks')).notebooks.find(book => book.id === fixture.notebook);
  assert.ok(notebook && !notebook.closed && !notebook.encrypted, 'fixture notebook must be open and unencrypted');
  await api('/api/petal/setPetalEnabled', { packageName: pluginName, enabled: true });
  // Snapshot only the existing fixtures. All subsequent mutations use new QA copies.
  const fixtureBefore = new Map();
  for (const id of [fixture.documentId, fixture.copyId]) fixtureBefore.set(id, await api('/api/block/getBlockKramdown', { id }));

  async function boot(target) {
    target.on('pageerror', error => report.pageErrors.push(error.message));
    await target.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await target.waitForFunction(() => window.siyuan?.layout?.centerLayout && window.siyuan.ws?.app?.plugins?.some(plugin => plugin.name === 'siyuan-child-cards'), undefined, { timeout: 60000 }).catch(async error => {
      report.bootFailure = await target.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(-1500), plugins: window.siyuan?.ws?.app?.plugins?.map(plugin => plugin.name) }));
      throw error;
    });
    await target.locator('[data-key="dialog-changelog"] .b3-dialog__scrim').click({ position: { x: 5, y: 5 }, timeout: 1000 }).catch(() => {});
    await target.locator('#message .b3-snackbar__close').first().click({ timeout: 1000 }).catch(() => {});
  }
  const page1 = await context.newPage();
  await boot(page1);
  const pluginAvailable = await page1.evaluate(() => Boolean(window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'siyuan-child-cards').canvasStore));
  assert.ok(pluginAvailable, 'already enabled 0.3 plugin must expose CanvasDocumentStore');
  async function newCopy(label) {
    const scene = await page1.evaluate(async ({ source, notebook, label }) => {
      const store = window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'siyuan-child-cards').canvasStore;
      const sourceScene = await store.load(source);
      return store.copy({ ...sourceScene, title: `安全测试 ${label} ${Date.now()}` }, { notebook });
    }, { source: fixture.documentId, notebook: fixture.notebook, label });
    report.copies[label] = scene.id;
    assert.notEqual(scene.id, fixture.documentId);
    return scene;
  }
  async function open(target, id) {
    await target.evaluate(async id => {
      const plugin = window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'siyuan-child-cards');
      await plugin.openCanvasDocument(id);
      const controller = [...plugin.canvases.values()].find(value => value.element.getClientRects().length);
      if (controller?.scene?.id !== id) throw new Error('requested QA board did not open');
    }, id);
    const more = target.locator('.scv-root:visible').last().getByRole('button', { name: '更多工具', exact: true });
    if (await more.count()) await more.click();
  }
  async function state(target) {
    return target.evaluate(() => {
      const controller = [...window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'siyuan-child-cards').canvases.values()].find(value => value.element.getClientRects().length);
      return { scene: controller.scene, dirty: controller.dirty, paused: controller.paused, status: controller.element.querySelector('.scv-status')?.textContent, tone: controller.element.querySelector('.scv-status')?.dataset.tone };
    });
  }
  async function editAndFlush(target, note, title) {
    await target.evaluate(async ({ note, title }) => {
      const controller = [...window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'siyuan-child-cards').canvases.values()].find(value => value.element.getClientRects().length);
      const nodes = controller.scene.nodes.map(node => node.kind === 'text' ? { ...node, text: note } : node);
      if (!nodes.some(node => node.kind === 'text')) throw new Error('QA fixture needs a text node');
      controller.change({ ...controller.scene, nodes, ...(title ? { title } : {}) });
      controller.view.setScene(controller.scene);
      await controller.flush();
    }, { note, title });
  }
  async function load(id) {
    return page1.evaluate(id => window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'siyuan-child-cards').canvasStore.load(id), id);
  }
  async function saveAttempt(scene) {
    return page1.evaluate(async scene => {
      try {
        const saved = await window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'siyuan-child-cards').canvasStore.save(scene, scene.revision);
        return { saved };
      } catch (error) { return { error: { name: error.name, message: error.message, latest: error.latest } }; }
    }, scene);
  }

  // A real failed write leaves a dirty controller. A second browser then wins.
  const concurrent = await newCopy('concurrent');
  await open(page1, concurrent.id);
  const secondContext = await browser.newContext({ viewport: { width: 1500, height: 1050 }, userAgent, storageState: await context.storageState() });
  const page2 = await secondContext.newPage();
  await boot(page2);
  await open(page2, concurrent.id);
  let abortedWrites = 0;
  await page1.route('**/api/block/updateBlock', async route => { abortedWrites++; await route.abort('failed'); });
  await editAndFlush(page1, '安全测试：窗口一必须完整保留的本地便签 🧭\n第二行');
  const failed = await state(page1);
  assert.ok(abortedWrites > 0 && failed.dirty && failed.paused);
  assert.match(failed.status, /保存失败/);
  await page1.unroute('**/api/block/updateBlock');
  await editAndFlush(page2, '安全测试：窗口二已保存的新正文');
  const remote = (await state(page2)).scene;
  const localBeforeRetry = (await state(page1)).scene;
  let retryWrites = 0;
  const countRetry = request => { if (request.url().endsWith('/api/block/updateBlock')) retryWrites++; };
  page1.on('request', countRetry);
  await page1.evaluate(async () => {
    const controller = [...window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'siyuan-child-cards').canvases.values()].find(value => value.element.getClientRects().length);
    controller.paused = false; await controller.flush();
  });
  page1.off('request', countRetry);
  const conflict = await state(page1);
  assert.ok(conflict.dirty && conflict.paused);
  assert.equal(conflict.tone, 'conflict');
  assert.equal(retryWrites, 0, 'conflicting retry must stop before a native write');
  assert.deepEqual(body(conflict.scene), body(localBeforeRetry), 'local layout and complete body survive conflict');
  await page1.evaluate(async notebook => {
    const controller = [...window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'siyuan-child-cards').canvases.values()].find(value => value.element.getClientRects().length);
    controller.host.chooseDestination = async () => ({ notebook });
    await controller.saveCopy();
  }, fixture.notebook);
  const preserved = (await state(page1)).scene;
  assert.notEqual(preserved.id, concurrent.id);
  assert.deepEqual(body(preserved), body(localBeforeRetry));
  assert.deepEqual(body(await load(concurrent.id)), body(remote), 'second browser version remains intact');
  assert.deepEqual(body(await load(preserved.id)), body(localBeforeRetry), 'saved local copy is complete');
  report.copies.concurrentLocal = preserved.id;
  report.concurrency = { abortedWrites, retryWrites, original: concurrent.id, localCopy: preserved.id, remoteText: text(remote), localText: text(preserved) };
  report.passed.push('failed write retains local draft', 'second browser conflict stops before update', 'save copy preserves both complete scenes');
  console.log('Canvas document concurrent save, conflict and copy passed');

  // A fresh invalid body must fail closed, without replacing it with a cached scene.
  const corrupt = await newCopy('corrupt');
  const corruptBlock = (await api('/api/block/getChildBlocks', { id: corrupt.id })).find(block => block.type === 'custom');
  assert.ok(corruptBlock);
  const goodKramdown = await api('/api/block/getBlockKramdown', { id: corruptBlock.id });
  const invalidMarkdown = `;;;${pluginName}/canvas-document\n{"broken":\n;;;\n{: id="${corruptBlock.id}" custom-scc-canvas="1"}`;
  await api('/api/block/updateBlock', { id: corruptBlock.id, dataType: 'markdown', data: invalidMarkdown });
  const invalidBefore = await api('/api/block/getBlockKramdown', { id: corruptBlock.id });
  const corruptionResult = await saveAttempt({ ...corrupt, title: corrupt.title + ' cached-save' });
  assert.ok(corruptionResult.error && !corruptionResult.saved);
  assert.deepEqual(await api('/api/block/getBlockKramdown', { id: corruptBlock.id }), invalidBefore, 'corrupt fresh body is never overwritten');
  // Restore this disposable QA copy so it does not obstruct later list/UI tests.
  await api('/api/block/updateBlock', { id: corruptBlock.id, dataType: 'markdown', data: goodKramdown.kramdown });
  assert.deepEqual(body(await load(corrupt.id)), body(corrupt));
  report.corrupt = { id: corrupt.id, error: corruptionResult.error, originalInvalidBodyRetained: true, restoredAfterVerification: true };
  report.passed.push('fresh corrupt JSON cannot be overwritten by cached save');

  // Deleting a newly created QA document must never turn save into create.
  const deleted = await newCopy('deleted');
  const deletedInfo = await api('/api/block/getBlockInfo', { id: deleted.id });
  const physicalFile = path.join(workspace, 'data', fixture.notebook, ...deletedInfo.path.split('/').filter(Boolean));
  assert.ok(physicalFile.startsWith(workspace + path.sep));
  await api('/api/filetree/removeDocByID', { id: deleted.id });
  let createsDuringSave = 0;
  const countCreates = request => { if (request.url().endsWith('/api/filetree/createDocWithMd')) createsDuringSave++; };
  page1.on('request', countCreates);
  const deletionResult = await saveAttempt(deleted);
  page1.off('request', countCreates);
  assert.ok(deletionResult.error && !deletionResult.saved);
  assert.equal(createsDuringSave, 0);
  await assert.rejects(fs.access(physicalFile), { code: 'ENOENT' });
  report.deleted = { id: deleted.id, error: deletionResult.error, createsDuringSave, fileStillAbsent: true };
  report.passed.push('deleted QA document save rejects without recreation');

  // Pause the native update after both revision reads, rename natively, then continue.
  const renamed = await newCopy('rename-race');
  await open(page1, renamed.id);
  const nativeTitle = '原生改名应保留 ' + Date.now();
  let renameIntercepts = 0;
  await page1.route('**/api/block/updateBlock', async route => {
    renameIntercepts++;
    await api('/api/filetree/renameDocByID', { id: renamed.id, title: nativeTitle });
    await route.continue();
  }, { times: 1 });
  await editAndFlush(page1, '保存写入间隙发生原生改名', '本地试图使用的旧标题');
  await page1.unroute('**/api/block/updateBlock');
  const renameConflict = await state(page1);
  assert.equal(renameIntercepts, 1);
  assert.ok(renameConflict.dirty && renameConflict.paused);
  assert.equal(renameConflict.tone, 'conflict');
  assert.equal((await api('/api/block/getBlockInfo', { id: renamed.id })).rootTitle, nativeTitle);
  await page1.evaluate(async () => {
    const controller = [...window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'siyuan-child-cards').canvases.values()].find(value => value.element.getClientRects().length);
    controller.paused = false; await controller.flush();
  });
  assert.equal((await state(page1)).tone, 'conflict');
  assert.equal((await api('/api/block/getBlockInfo', { id: renamed.id })).rootTitle, nativeTitle, 'retry cannot revert native title');
  report.rename = { id: renamed.id, nativeTitle, intercepts: renameIntercepts, conflict: true, titlePreservedAfterRetry: true };
  report.passed.push('native rename during update triggers conflict and retry preserves native title');
  console.log('Fresh corrupt JSON, deleted document and native rename race passed');

  for (const [id, before] of fixtureBefore) assert.deepEqual(await api('/api/block/getBlockKramdown', { id }), before, 'original integration fixtures remain unchanged');
  report.passed.push('original integration fixtures unchanged');
  report.pluginStillEnabled = await page1.evaluate(() => window.siyuan.ws.app.plugins.some(plugin => plugin.name === 'siyuan-child-cards'));
  assert.ok(report.pluginStillEnabled);
  await fs.writeFile(output, JSON.stringify(report, null, 2));
  console.log('Canvas document safety passed', JSON.stringify({ copies: report.copies, passed: report.passed }));
  await browser.close();
})().catch(async error => {
  report.failure = { name: error.name, message: error.message, stack: error.stack };
  await fs.writeFile(output, JSON.stringify(report, null, 2)).catch(() => {});
  console.error(error);
  await browser?.close().catch(() => {});
  process.exitCode = 1;
});
