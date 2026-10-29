const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const base = 'http://127.0.0.1:6807';
const pluginName = 'siyuan-child-cards';
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
let browser, page;

(async () => {
  await fs.mkdir(path.join(root, '.qa'), { recursive: true });
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({ viewport: { width: 1550, height: 1080 }, userAgent });
  assert.equal((await (await context.request.post(base + '/api/system/loginAuth', { data: { authCode: 'child-cards-isolated-test' } })).json()).code, 0);
  async function api(route, data = {}) {
    const result = await (await context.request.post(base + route, { data })).json();
    assert.equal(result.code, 0, `${route}: ${result.msg}`);
    return result.data;
  }
  const workspace = await api('/api/system/getWorkspaceInfo');
  assert.equal(path.resolve(workspace.workspaceDir).toLowerCase(), path.join(root, '.test-workspace').toLowerCase(), 'Refuse to mutate a user workspace');
  const destination = path.resolve(root, '.test-workspace', 'data', 'plugins', pluginName);
  assert.ok(destination.startsWith(path.resolve(root, '.test-workspace') + path.sep), 'Plugin installation stays in the isolated workspace');
  await api('/api/setting/setBazaar', { trust: true, petalDisabled: false });
  await api('/api/petal/setPetalEnabled', { packageName: pluginName, enabled: false });
  await fs.cp(path.join(root, 'dist'), destination, { recursive: true });
  await api('/api/petal/setPetalEnabled', { packageName: pluginName, enabled: true });

  const token = Date.now();
  const notebook = (await api('/api/notebook/createNotebook', { name: 'Canvas Create QA ' + token })).notebook.id;
  assert.match(notebook, /^\d{14}-[a-z0-9]{7}$/);
  const intro = '真实斜杠创建入口测试 ' + token;
  const fixture = await api('/api/filetree/createDocWithMd', { notebook, path: '/创建入口测试 ' + token, markdown: intro });
  const errors = [];
  const creates = [];
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).pathname !== '/api/filetree/createDocWithMd') return;
    try { creates.push(request.postDataJSON()); } catch { /* Invalid requests will fail their own UI/API checks. */ }
  });
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.siyuan?.layout?.centerLayout && window.siyuan.ws?.app?.plugins?.some(plugin => plugin.name === 'siyuan-child-cards'), { timeout: 60000 });
  await page.locator('[data-key="dialog-changelog"] .b3-dialog__scrim').click({ position: { x: 5, y: 5 }, timeout: 1500 }).catch(() => {});
  await page.locator('#message .b3-snackbar__close').first().click({ timeout: 1500 }).catch(() => {});

  const dialog = () => page.locator('.scv-destination:visible');
  const canvas = () => page.locator('.scv-root:visible').last();
  const snapshot = () => page.evaluate(() => [...window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'siyuan-child-cards').canvases.values()].map(controller => ({
    id: controller.scene?.id, title: controller.scene?.title, visible: !!controller.element.getClientRects().length,
  })));
  let sqlSequence = 0;
  async function documents() {
    return api('/api/query/sql', { stmt: `SELECT id,content,hpath FROM blocks WHERE type='d' AND box='${notebook}' ORDER BY id /* create-qa-${token}-${++sqlSequence} */`, mode: 'readonly' });
  }
  async function expectCount(count) {
    let actual;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      actual = await documents();
      if (actual.length === count) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(actual?.length, count, 'The native SQL index eventually contains the exact document count');
  }
  async function command(langKey, twice = false) {
    await page.evaluate(({ langKey, twice }) => {
      const plugin = window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'siyuan-child-cards');
      const entry = plugin.commands.find(command => command.langKey === langKey);
      if (!entry?.callback) throw new Error(`Command missing: ${langKey}`);
      // Do not await a callback that may itself wait for the modal's answer.
      void entry.callback();
      if (twice) void entry.callback();
    }, { langKey, twice });
    await dialog().waitFor({ timeout: 15000 });
  }
  async function chooseNameAndLocation(title) {
    await dialog().waitFor();
    assert.equal(await dialog().count(), 1, 'Only one creation dialog is visible');
    await dialog().getByRole('textbox', { name: '画布名称', exact: true }).fill(title);
    await dialog().getByLabel('保存到笔记本', { exact: true }).selectOption(notebook);
    await dialog().getByRole('button', { name: '放在根目录', exact: true }).click();
    await dialog().getByRole('button', { name: '保存到这里', exact: true }).click();
  }
  async function waitForCreated(title, previousIds) {
    await page.waitForFunction(({ title, previousIds }) => {
      const plugin = window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'siyuan-child-cards');
      if (plugin.creationTask) return false;
      return [...plugin.canvases.values()].some(controller => controller.element.getClientRects().length &&
        controller.scene?.title === title && !previousIds.includes(controller.scene.id) &&
        !controller.dirty && !controller.saveTask && !controller.transitionTask);
    }, { title, previousIds }, { timeout: 30000 });
    const visible = (await snapshot()).filter(item => item.visible && item.title === title && !previousIds.includes(item.id));
    assert.equal(visible.length, 1, 'The newly-created document is active in its own Canvas tab');
    assert.match(visible[0].id, /^\d{14}-[a-z0-9]{7}$/);
    return visible[0].id;
  }
  async function waitForBoard(id) {
    await page.waitForFunction(id => {
      const plugin = window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'siyuan-child-cards');
      return !plugin.creationTask && [...plugin.canvases.values()].some(controller => controller.element.getClientRects().length &&
        controller.scene?.id === id && !controller.dirty && !controller.saveTask && !controller.transitionTask);
    }, id, { timeout: 30000 });
  }
  async function openBoard(id) {
    await page.evaluate(id => { void window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'siyuan-child-cards').openCanvasDocument(id); }, id);
    await waitForBoard(id);
  }
  async function body(id) {
    const children = await api('/api/block/getChildBlocks', { id });
    const blocks = children.filter(child => ['custom', 'custom_b', 'custom-block', 'NodeCustomBlock'].includes(child.type));
    assert.equal(blocks.length, 1, 'One native Canvas block per document');
    return (await api('/api/block/getBlockKramdown', { id: blocks[0].id })).kramdown;
  }

  await page.evaluate(id => { void window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'siyuan-child-cards').openDocument(id); }, fixture);
  await page.locator('.protyle:visible').getByText(intro, { exact: true }).last().waitFor();
  await expectCount(1);
  const initialTabs = await snapshot();
  const ids = [];

  const aName = '命令创建 A ' + token;
  await command('newCanvas');
  // Empty or whitespace-only names cannot submit a document.
  await dialog().getByRole('textbox', { name: '画布名称', exact: true }).fill('   ');
  assert.equal(await dialog().getByRole('button', { name: '保存到这里', exact: true }).isDisabled(), true);
  await dialog().getByRole('textbox', { name: '画布名称', exact: true }).press('Enter');
  assert.equal(await dialog().count(), 1);
  assert.equal((await documents()).length, 1);
  await chooseNameAndLocation(aName);
  const a = await waitForCreated(aName, ids); ids.push(a); await expectCount(2);
  await canvas().getByRole('button', { name: '添加便签', exact: true }).click();
  const note = 'A 的原始内容必须保留 ' + token;
  await canvas().getByRole('button', { name: '编辑便签', exact: true }).click();
  await canvas().getByRole('textbox', { name: '便签内容', exact: true }).fill(note);
  await waitForBoard(a);
  const aBefore = await body(a);
  assert.ok(aBefore.includes(note));

  const bName = '英文命令创建 B ' + token;
  await command('newCanvasEnglish'); await chooseNameAndLocation(bName);
  const b = await waitForCreated(bName, ids); ids.push(b); await expectCount(3);
  assert.notEqual(a, b);
  const tabsAfterB = await snapshot();
  assert.equal(tabsAfterB.filter(item => item.id === a).length, 1);
  assert.equal(tabsAfterB.filter(item => item.id === b).length, 1);
  assert.deepEqual(await body(a), aBefore, 'Creating B must not write or replace A');
  console.log('Command/English creation and independent A/B tabs passed', { a, b });

  const countBeforeCancel = (await documents()).length;
  const requestsBeforeCancel = creates.length;
  const tabsBeforeCancel = (await snapshot()).length;
  await command('newCanvas');
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  await page.waitForFunction(() => !window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'siyuan-child-cards').creationTask);
  await expectCount(countBeforeCancel);
  assert.equal(creates.length, requestsBeforeCancel, 'Cancellation emits no create request');
  assert.equal((await snapshot()).length, tabsBeforeCancel);
  assert.equal(await dialog().count(), 0);

  // Exercise the actual Protyle slash menu, rather than directly calling the
  // plugin's slash callback: the keyword must be discoverable in the editor.
  await page.evaluate(id => { void window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'siyuan-child-cards').openDocument(id); }, fixture);
  await page.locator('.protyle:visible').getByText(intro, { exact: true }).last().click();
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await page.keyboard.type('/newcanvas', { delay: 65 });
  const slash = page.locator('.protyle-hint:visible').getByText(/新建.*Canvas|New Canvas/).last();
  await slash.waitFor({ timeout: 10000 }); await slash.click();
  const cName = '斜杠创建 C ' + token;
  await chooseNameAndLocation(cName);
  const c = await waitForCreated(cName, ids); ids.push(c); await expectCount(4);
  assert.deepEqual(await body(a), aBefore);
  console.log('Cancel, empty-name protection and real slash menu passed', { c });

  // The toolbar shares the same new-document flow and retains the current tab.
  const dName = '工具栏创建 D ' + token;
  await canvas().getByRole('button', { name: '新建', exact: true }).click();
  await dialog().waitFor();
  assert.equal((await dialog().innerText()).includes(`父文档：${cName}`), false, 'New Canvas must not default to being a child of the current Canvas');
  await chooseNameAndLocation(dName);
  const d = await waitForCreated(dName, ids); ids.push(d); await expectCount(5);
  const dInfo = await api('/api/block/getBlockInfo', { id: d });
  assert.equal(dInfo.path, '/' + d + '.sy', 'Selected notebook root is respected');
  assert.equal((await snapshot()).filter(item => item.id === c).length, 1, 'Toolbar creation retains the prior Canvas tab');

  // Opening A by its owner document must activate A, irrespective of which
  // Canvas was most recently created. Repeating it must reuse that exact tab.
  const beforeOpen = await snapshot();
  await openBoard(a);
  assert.equal(await canvas().locator('textarea.scv-note-text').inputValue(), note);
  await openBoard(a); await openBoard(a);
  assert.equal((await snapshot()).length, beforeOpen.length);
  assert.equal((await snapshot()).filter(item => item.id === a).length, 1);
  await page.evaluate(() => { void window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'siyuan-child-cards').openCanvas(); });
  await waitForBoard(a);
  await expectCount(5);
  assert.deepEqual(await body(a), aBefore);
  console.log('Toolbar new tab and exact/repeated owner-document opening passed', { d });

  // Actual topbar menu must expose the distinct create action as well.
  const eName = '顶栏菜单创建 E ' + token;
  await page.locator('[aria-label="Canvas 画布 · 新建 / 打开"],[title="Canvas 画布 · 新建 / 打开"]').first().click();
  await page.locator(':text-is("新建 Canvas · New Canvas"):visible').last().click();
  await chooseNameAndLocation(eName);
  const e = await waitForCreated(eName, ids); ids.push(e); await expectCount(6);

  // Deliver two clicks in the same event turn, before an async notebook read
  // can install its overlay. This exercises the creationTask race directly.
  const fName = '双击仅创建一次 F ' + token;
  const requestsBefore = creates.length;
  await canvas().getByRole('button', { name: '新建', exact: true }).evaluate(button => { button.click(); button.click(); });
  await dialog().waitFor();
  assert.equal(await dialog().count(), 1);
  await chooseNameAndLocation(fName);
  const f = await waitForCreated(fName, ids); ids.push(f); await expectCount(7);
  assert.equal(creates.length - requestsBefore, 1, 'Rapid double creation emits exactly one createDocWithMd request');
  assert.equal((await api('/api/block/getBlockInfo', { id: f })).rootTitle, fName);
  assert.equal(await dialog().count(), 0);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.equal((await snapshot()).filter(item => item.id === id).length, 1, 'Each created document owns one independent Canvas tab');
  assert.deepEqual(await body(a), aBefore);
  const tabsBeforeUnload = await snapshot();
  await page.screenshot({ path: path.join(root, '.qa', 'canvas-create.png'), fullPage: true });

  // Unloading while a nested picker is open must cancel the entire creation
  // flow, including the body-anchored dialog used by the global command.
  await expectCount(7);
  const documentIdsBeforeUnload = (await documents()).map(doc => doc.id).sort();
  const requestsBeforeUnload = creates.length;
  await command('newCanvas');
  await dialog().getByRole('textbox', { name: '画布名称', exact: true }).fill('卸载时不得创建 ' + token);
  await dialog().getByLabel('保存到笔记本', { exact: true }).selectOption(notebook);
  await dialog().getByRole('button', { name: '选择父文档', exact: true }).click();
  await page.locator('.scc-canvas-picker:visible').waitFor();
  assert.equal(await page.locator('.scv-destination').count(), 1, 'The outer destination remains mounted behind its picker');
  let documentIdsAfterUnload;
  try {
    await api('/api/petal/setPetalEnabled', { packageName: pluginName, enabled: false });
    await page.waitForFunction(() => !window.siyuan.ws.app.plugins.some(plugin => plugin.name === 'siyuan-child-cards'), { timeout: 15000 });
    await page.waitForFunction(() => !document.querySelector('.scv-destination,.scc-canvas-picker'), { timeout: 10000 });
    assert.equal(await page.locator('.scv-destination,.scc-canvas-picker').count(), 0, 'Unload removes both outer and inner dialogs');
    assert.equal(creates.length, requestsBeforeUnload, 'Unload does not create a pending document');
    await expectCount(7);
    documentIdsAfterUnload = (await documents()).map(doc => doc.id).sort();
    assert.deepEqual(documentIdsAfterUnload, documentIdsBeforeUnload, 'Unload preserves exactly the existing document IDs');
    assert.deepEqual(await body(a), aBefore);
  } finally {
    // Leave the isolated instance enabled for subsequent regression scripts.
    await api('/api/petal/setPetalEnabled', { packageName: pluginName, enabled: true });
    await page.waitForFunction(() => window.siyuan.ws.app.plugins.some(plugin => plugin.name === 'siyuan-child-cards'), { timeout: 15000 });
  }
  assert.equal(creates.length, requestsBeforeUnload, 'Re-enabling cannot resume the cancelled creation');
  console.log('Unload cancels outer destination and nested picker without creating a document');
  const pluginErrors = errors.filter(error => /Canvas|scv-|child-cards|Cannot read properties/.test(error));
  assert.deepEqual(pluginErrors, []);
  const passed = [
    'Chinese and English new commands', 'empty name prevents creation', 'new A/B documents and independent tabs',
    'A contents unchanged', 'cancel creates no document or tab', 'actual /newcanvas menu',
    'toolbar new keeps previous tab and avoids nesting in current Canvas', 'exact owner-document opening',
    'repeat open reuses tab and creates no document', 'open-existing preserves active Canvas',
    'topbar New Canvas menu', 'rapid double click opens one dialog and creates once',
    'plugin unload cancels nested picker and destination without a create request or new document',
  ];
  await fs.writeFile(path.join(root, '.qa', 'canvas-create-integration.json'), JSON.stringify({ notebook, fixture, ids, initialTabs, tabsBeforeUnload, finalTabs: await snapshot(), createRequests: creates.length, documentIdsBeforeUnload, documentIdsAfterUnload, errors, passed }, null, 2));
  console.log('Canvas creation integration passed', { notebook, ids, createRequests: creates.length, errors });
  await browser.close();
})().catch(async error => {
  console.error(error);
  if (page) {
    await page.screenshot({ path: path.join(root, '.qa', 'canvas-create-failure.png'), fullPage: true }).catch(() => {});
    console.error(await page.evaluate(() => document.body.innerText.slice(-3500)).catch(() => 'no browser state'));
  }
  await browser?.close().catch(() => {});
  process.exitCode = 1;
});
