const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), base = 'http://127.0.0.1:6807', name = 'siyuan-child-cards';
let browser, page;
const report = { passed: [], errors: [] };
(async () => {
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({ viewport: { width: 1680, height: 1180 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36' });
  const login = await (await context.request.post(base + '/api/system/loginAuth', { data: { authCode: 'child-cards-isolated-test' } })).json(); assert.equal(login.code, 0);
  async function api(route, data = {}) {
    const response = await (await context.request.post(base + route, { data })).json(); assert.equal(response.code, 0, `${route}: ${response.msg}`); return response.data;
  }
  assert.equal(path.resolve((await api('/api/system/getWorkspaceInfo')).workspaceDir).toLowerCase(), path.join(root, '.test-workspace').toLowerCase(), 'Refuse to change a user workspace');
  await api('/api/setting/setBazaar', { trust: true, petalDisabled: false });
  await api('/api/petal/setPetalEnabled', { packageName: name, enabled: false });
  await fs.cp(path.join(root, 'dist'), path.join(root, '.test-workspace/data/plugins', name), { recursive: true });
  await api('/api/petal/setPetalEnabled', { packageName: name, enabled: true });
  const stamp = Date.now(); const notebook = (await api('/api/notebook/createNotebook', { name: 'Canvas Features QA ' + stamp })).notebook.id;
  const parentTitle = '自动跟随源 ' + stamp;
  const parent = await api('/api/filetree/createDocWithMd', { notebook, path: '/' + parentTitle, markdown: '父文档正文保留。' });
  const child = await api('/api/filetree/createDocWithMd', { notebook, path: '/' + parentTitle + '/子页一', markdown: '子页原文 ' + stamp });
  const hostA = await api('/api/filetree/createDocWithMd', { notebook, path: '/共享嵌入 A ' + stamp, markdown: 'A 前文 ' + stamp + '\n\nA 后文 ' + stamp });
  const hostB = await api('/api/filetree/createDocWithMd', { notebook, path: '/共享嵌入 B ' + stamp, markdown: 'B 前文 ' + stamp + '\n\nB 后文 ' + stamp });
  const sourceBefore = await api('/api/block/getBlockKramdown', { id: child });
  page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.siyuan?.layout?.centerLayout && window.siyuan?.ws?.app?.plugins?.some(p => p.name === 'siyuan-child-cards'), undefined, { timeout: 60000 });
  await page.locator('[data-key="dialog-changelog"] .b3-dialog__scrim').click({ position: { x: 5, y: 5 }, timeout: 1000 }).catch(() => {});
  await page.locator('#message .b3-snackbar__close').first().click({ timeout: 1000 }).catch(() => {});
  const image = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 64; c.height = 48; const ctx = c.getContext('2d'); ctx.fillStyle = '#5489cc'; ctx.fillRect(0, 0, 64, 48); return c.toDataURL('image/png').split(',')[1]; }), 'base64');
  const asset = 'assets/canvas-features-' + stamp + '.png';
  assert.equal((await (await context.request.post(base + '/api/file/putFile', { multipart: { path: '/data/' + asset, isDir: 'false', file: { name: path.basename(asset), mimeType: 'image/png', buffer: image } } })).json()).code, 0);
  const board = await page.evaluate(async ({ notebook, child, stamp, asset }) => {
    const plugin = window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards');
    const scene = await plugin.canvasStore.create('综合画布 ' + stamp, { notebook });
    scene.nodes = [
      { id: 'group', kind: 'group', title: '公式推导', x: 0, y: 0, width: 700, height: 360, color: 'blue' },
      { id: 'note-a', kind: 'text', text: '组内目标关键词 ' + stamp, groupId: 'group', x: 30, y: 80, width: 280, height: 220, color: 'green' },
      { id: 'note-b', kind: 'text', text: '推导第二步', groupId: 'group', x: 370, y: 80, width: 280, height: 220, color: 'orange' },
      { id: 'doc', kind: 'doc', docId: child, title: '子页一', x: 850, y: 60, width: 320, height: 240, color: 'purple' },
      { id: 'far', kind: 'text', text: '定位远处节点', x: 1400, y: 700, width: 280, height: 200, color: 'blue' },
      { id: 'image', kind: 'file', file: asset, name: '模板附件', mediaType: 'image', x: 850, y: 400, width: 200, height: 140, color: 'neutral' },
    ];
    scene.edges = [{ id: 'edge-a', from: 'note-a', to: 'doc', label: '验证', color: 'green' }, { id: 'edge-b', from: 'doc', to: 'far', label: '结论', color: 'orange' }];
    await plugin.canvasStore.save(scene, scene.revision); await plugin.openCanvasDocument(scene.id); return scene.id;
  }, { notebook, child, stamp, asset });
  report.notebook = notebook; report.board = board; report.hostA = hostA; report.hostB = hostB;
  const canvas = () => page.locator('.scv-root:visible').last();
  const state = () => page.evaluate(id => {
    const p = window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards');
    const c = [...p.canvases.values(), ...[...p.inlineCanvases.values()].flatMap(m => [...m.values()].map(v => v.controller))].find(c => c.scene?.id === id && c.element.getClientRects().length);
    return c?.scene;
  }, board);
  const saved = () => page.waitForFunction(id => {
    const p = window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards');
    const c = [...p.canvases.values(), ...[...p.inlineCanvases.values()].flatMap(m => [...m.values()].map(v => v.controller))].find(c => c.scene?.id === id && c.element.getClientRects().length);
    return c?.scene && !c.dirty && !c.saveTask && !c.transitionTask;
  }, board, { timeout: 25000 });
  const focusNode = async id => {
    await page.evaluate(async ({ board, id }) => {
      const p = window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards');
      const c = [...p.canvases.values(), ...[...p.inlineCanvases.values()].flatMap(m => [...m.values()].map(v => v.controller))].find(c => c.scene?.id === board && c.element.getClientRects().length);
      await c.focusNode(id);
    }, { board, id }); await saved();
  };
  const waitNode = (docId, present = true) => page.waitForFunction(({ board, docId, present }) => {
    const p = window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards');
    return [...p.canvases.values()].some(c => c.scene?.id === board && c.scene.nodes.some(n => n.kind === 'doc' && n.docId === docId) === present && !c.dirty && !c.saveTask);
  }, { board, docId, present }, { timeout: 25000 });
  await saved();
  assert.equal(await canvas().locator('.scv-advanced-tools').isVisible(), false, 'Compact toolbar is the default');
  await canvas().getByRole('button', { name: '更多工具', exact: true }).click();
  assert.equal(await canvas().getByRole('button', { name: '添加附件', exact: true }).isVisible(), true);
  await canvas().getByRole('button', { name: '收起工具', exact: true }).click();
  await canvas().getByRole('button', { name: '适应全部', exact: true }).click(); await saved();
  const initial = await state();
  await canvas().locator('[data-scv-node-id="group"] .scv-fold-group').click(); await saved();
  assert.equal(await canvas().locator('[data-scv-node-id="note-a"]').isVisible(), false);
  const folded = await state(); assert.equal(folded.nodes.length, initial.nodes.length); assert.deepEqual(folded.edges, initial.edges);
  assert.equal(folded.nodes.find(n => n.id === 'group').height, 360); assert.ok(folded.nodes.find(n => n.id === 'group').collapsed);
  assert.equal(await canvas().locator('[data-scv-node-id="group"]').evaluate(n => getComputedStyle(n).height), '52px');
  await canvas().getByRole('searchbox', { name: '搜索画布', exact: true }).fill('组内目标关键词');
  await canvas().locator('.scv-search-result').first().click(); await saved();
  assert.equal((await state()).nodes.find(n => n.id === 'group').collapsed, false);
  assert.equal(await canvas().locator('[data-scv-node-id="note-a"]').isVisible(), true);
  assert.ok(await canvas().locator('[data-scv-node-id="note-a"]').evaluate(n => n.classList.contains('scv-selected')));
  const panBefore = (await state()).viewport;
  await canvas().locator('.scv-minimap').click({ position: { x: 120, y: 80 } }); await saved();
  assert.notDeepEqual((await state()).viewport, panBefore);
  await canvas().getByLabel('跳到分组', { exact: true }).selectOption('group'); await saved();
  await canvas().getByRole('button', { name: '适应全部', exact: true }).click(); await saved();
  const edge = canvas().locator('[data-edge-id="edge-a"] .scv-edge-path');
  await edge.dispatchEvent('contextmenu', { bubbles: true, clientX: 700, clientY: 400 });
  await canvas().getByRole('menuitem', { name: '跳到连线终点', exact: true }).click(); await saved();
  assert.ok(await canvas().locator('[data-scv-node-id="doc"]').evaluate(n => n.classList.contains('scv-selected')));
  report.passed.push('compact and expanded toolbar', 'folding preserves contents geometry and edges', 'search reveals hidden members', 'minimap navigation', 'jump to group and connection endpoint');
  console.log('Toolbar, folding, search, minimap and connection navigation passed');

  await canvas().getByRole('button', { name: '更多工具', exact: true }).click();
  await canvas().getByRole('button', { name: '跟随子页', exact: true }).click();
  const picker = page.locator('.scc-canvas-picker:visible'); await picker.waitFor();
  await picker.getByRole('searchbox', { name: '搜索思源文档' }).fill(parent);
  await picker.getByRole('searchbox', { name: '搜索思源文档' }).press('Enter');
  await picker.getByRole('button', { name: '跟随此文档的子页', exact: true }).click();
  await page.waitForFunction(({ board, parent }) => [...window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').canvases.values()].some(c => c.scene?.id === board && c.scene.followParentId === parent && c.scene.nodes.some(n => n.id === 'doc' && n.followedFrom === parent) && !c.dirty && !c.saveTask), { board, parent }, { timeout: 20000 });
  const child2 = await api('/api/filetree/createDocWithMd', { notebook, path: '/' + parentTitle + '/子页二', markdown: '新增子页正文。' });
  await waitNode(child2); const followed = await state();
  assert.equal(followed.nodes.find(n => n.id === 'doc').x, 850, 'Following keeps manually positioned cards');
  await api('/api/filetree/moveDocsByID', { fromIDs: [child], toID: hostB });
  await page.waitForFunction(board => [...window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').canvases.values()].some(c => c.scene?.id === board && c.scene.nodes.find(n => n.id === 'doc')?.detached && !c.dirty && !c.saveTask), board, { timeout: 20000 });
  assert.equal((await state()).nodes.find(n => n.id === 'doc').x, 850);
  const child2Node = (await state()).nodes.find(n => n.kind === 'doc' && n.docId === child2).id;
  await focusNode(child2Node); await canvas().locator('.scv-stage').press('Delete'); await saved();
  const child3 = await api('/api/filetree/createDocWithMd', { notebook, path: '/' + parentTitle + '/子页三', markdown: '触发跟随刷新。' });
  await waitNode(child3); assert.ok(!(await state()).nodes.some(n => n.kind === 'doc' && n.docId === child2));
  assert.ok((await state()).followExcluded.includes(child2)); assert.equal((await api('/api/block/getBlockInfo', { id: child2 })).rootID, child2);
  const beforeFollowFailure = (await state()).nodes;
  await page.route('**/api/filetree/listDocsByPath', route => route.abort('failed'));
  await page.evaluate(board => [...window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').canvases.values()].find(c => c.scene?.id === board && c.element.getClientRects().length).check(), board);
  await canvas().locator('.scv-status').filter({ hasText: '子页跟随暂未完成' }).waitFor();
  assert.deepEqual((await state()).nodes, beforeFollowFailure); await page.unroute('**/api/filetree/listDocsByPath');
  report.passed.push('failed child listing preserves all existing cards');
  await canvas().getByRole('button', { name: '停止跟随', exact: true }).click(); await saved(); assert.equal((await state()).followParentId, undefined);
  report.passed.push('new children added without moving existing cards', 'moved children are marked without deletion', 'manual removal excluded from following', 'stop following retains cards');
  await canvas().locator('.scv-stage').press('Escape');
  const edgesBeforeLayout = (await state()).edges;
  await canvas().getByLabel('排列所选节点').selectOption('tree-right'); await saved();
  const tree = await state(); assert.deepEqual(tree.edges, edgesBeforeLayout);
  assert.ok(tree.nodes.find(n => n.id === 'group').x < tree.nodes.find(n => n.id === 'doc').x);
  await canvas().getByLabel('排列所选节点').selectOption('tree-down'); await saved();
  assert.ok((await state()).nodes.find(n => n.id === 'group').y < (await state()).nodes.find(n => n.id === 'doc').y);
  report.passed.push('horizontal and vertical connected layout');
  console.log('Automatic child following, exclusions and connected layout passed');

  const countBeforeTemplate = (await state()).nodes.length;
  await canvas().getByRole('button', { name: '模板', exact: true }).click();
  let templates = page.getByRole('dialog', { name: '画布模板', exact: true }); await templates.waitFor();
  await templates.getByLabel('选择画布模板').selectOption('builtin-concept');
  await templates.getByRole('button', { name: '添加到当前画布', exact: true }).click(); await saved();
  assert.equal((await state()).nodes.length, countBeforeTemplate + 5);
  await canvas().getByRole('button', { name: '模板', exact: true }).click(); await templates.waitFor();
  await templates.getByLabel('新模板名称').fill('自定义结构 ' + stamp);
  await templates.getByRole('button', { name: '将当前画布保存为模板', exact: true }).click();
  await templates.getByRole('status').filter({ hasText: '已保存为独立模板文档' }).waitFor({ timeout: 20000 });
  const templateId = await templates.getByLabel('选择画布模板').inputValue(); report.templateId = templateId;
  assert.match(templateId, /^\d{14}-[a-z0-9]{7}$/);
  const templateAttrs = await api('/api/attr/getBlockAttrs', { id: templateId }); assert.equal(templateAttrs['custom-scc-template'], '1');
  const templateBlock = (await api('/api/block/getChildBlocks', { id: templateId })).find(b => b.type === 'custom');
  assert.ok(Object.values(await api('/api/attr/getBlockAttrs', { id: templateBlock.id })).includes(asset), 'Template document registers attachment references');
  await templates.getByRole('button', { name: '关闭', exact: true }).click();
  report.passed.push('built-in templates append independent cards', 'custom templates are native canvas documents with asset registration');

  async function openHost(id, marker) {
    await page.evaluate(id => window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').openDocument(id), id);
    await page.locator('.protyle:visible .protyle-wysiwyg').getByText(marker, { exact: true }).waitFor();
  }
  async function insertReference(host, marker) {
    await openHost(host, marker);
    const paragraph = page.locator('.protyle:visible .protyle-wysiwyg').getByText(marker, { exact: true });
    await paragraph.click(); await page.keyboard.press('End'); await page.keyboard.press('Enter');
    await page.evaluate(() => window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').commands.find(c => c.langKey === 'embedCanvas').callback());
    const dialog = page.getByRole('dialog', { name: '插入或引用 Canvas', exact: true }); await dialog.waitFor();
    await dialog.getByRole('searchbox', { name: '搜索已有画布' }).fill(board);
    await dialog.getByLabel('选择已有画布').selectOption(board);
    await dialog.getByRole('button', { name: '引用所选画布', exact: true }).click();
    await page.locator(`.scv-inline[data-canvas-document="${board}"][data-canvas-host="${host}"]:visible`).waitFor(); await saved();
  }
  await insertReference(hostA, 'A 前文 ' + stamp);
  await focusNode('note-a');
  await canvas().locator('[data-scv-node-id="note-a"]').getByRole('button', { name: '编辑便签', exact: true }).click();
  await canvas().locator('[data-scv-node-id="note-a"] textarea').fill('来自文档 A 的共享修改 ' + stamp); await saved();
  const hostMarkdown = (await api('/api/block/getBlockKramdown', { id: hostA })).kramdown;
  assert.ok(hostMarkdown.includes('/canvas-reference') && hostMarkdown.includes(board)); assert.ok(!hostMarkdown.includes('来自文档 A 的共享修改'));
  await insertReference(hostB, 'B 前文 ' + stamp);
  assert.equal((await state()).nodes.find(n => n.id === 'note-a').text, '来自文档 A 的共享修改 ' + stamp);
  await focusNode('note-a'); await canvas().locator('[data-scv-node-id="note-a"]').getByRole('button', { name: '编辑便签', exact: true }).click();
  await canvas().locator('[data-scv-node-id="note-a"] textarea').fill('来自文档 B 的共享修改 ' + stamp); await saved();
  await openHost(hostA, 'A 前文 ' + stamp); await saved();
  await page.waitForFunction(({ board, hostA, stamp }) => [...window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').inlineCanvases.values()].some(m => [...m.values()].some(v => v.anchor.dataset.canvasHost === hostA && v.controller.scene?.id === board && v.controller.scene.nodes.some(n => n.id === 'note-a' && n.text === '来自文档 B 的共享修改 ' + stamp))), { board, hostA, stamp });
  assert.deepEqual(await api('/api/block/getBlockKramdown', { id: child }), sourceBefore);
  report.passed.push('insert existing canvas at document cursor', 'two documents share one editable canvas without duplicating scene data', 'cross-view changes preserve surrounding body and original notes');
  console.log('Native templates and shared inline references passed');

  if (await canvas().getByRole('button', { name: '更多工具', exact: true }).count()) await canvas().getByRole('button', { name: '更多工具', exact: true }).click();
  await canvas().getByRole('button', { name: '跟随子页', exact: true }).click(); await picker.waitFor();
  await picker.getByRole('searchbox', { name: '搜索思源文档' }).fill(parent); await picker.getByRole('searchbox', { name: '搜索思源文档' }).press('Enter');
  await picker.getByRole('button', { name: '跟随此文档的子页', exact: true }).click();
  await waitNode(child2); await saved();
  await focusNode('note-a'); await canvas().locator('[data-scv-node-id="note-a"]').getByRole('button', { name: '编辑便签', exact: true }).click();
  await page.route('**/api/block/updateBlock', async route => { await new Promise(resolve => setTimeout(resolve, 900)); await route.continue(); });
  await canvas().locator('[data-scv-node-id="note-a"] textarea').fill('来自文档 B 的共享修改 ' + stamp);
  const child4 = await api('/api/filetree/createDocWithMd', { notebook, path: '/' + parentTitle + '/子页四', markdown: '多视图自动跟随。' });
  await waitNode(child4); await saved(); await page.unroute('**/api/block/updateBlock');
  const allPeers = await page.evaluate(board => {
    const p = window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards');
    return [...p.canvases.values(), ...[...p.inlineCanvases.values()].flatMap(m => [...m.values()].map(v => v.controller))].filter(c => c.scene?.id === board).map(c => ({ paused: c.paused, dirty: c.dirty }));
  }, board);
  assert.ok(allPeers.length >= 3 && allPeers.every(peer => !peer.paused));
  assert.equal((await state()).nodes.filter(n => n.kind === 'doc' && n.docId === child4).length, 1);
  assert.equal((await state()).nodes.find(n => n.id === 'note-a').text, '来自文档 B 的共享修改 ' + stamp);
  await canvas().getByRole('button', { name: '停止跟随', exact: true }).click(); await saved();
  report.passed.push('shared views follow new children once while a source save is delayed');

  await page.evaluate(id => window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').showReferences(id), child);
  let refs = page.getByRole('dialog', { name: '画布反向引用', exact: true }); await refs.waitFor();
  await refs.getByRole('status').filter({ hasText: /找到.*个引用/ }).waitFor({ timeout: 60000 });
  await refs.locator('.scv-reference-result').filter({ hasText: '综合画布 ' + stamp }).first().click(); await saved();
  assert.ok(await canvas().locator('[data-scv-node-id="doc"]').evaluate(n => n.classList.contains('scv-selected')));
  await page.evaluate(id => window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').showReferences(id), board); await refs.waitFor();
  await refs.locator('.scv-reference-result').filter({ hasText: '共享嵌入 A ' + stamp }).waitFor({ timeout: 60000 });
  assert.ok(await refs.locator('.scv-reference-result').filter({ hasText: '共享嵌入 B ' + stamp }).count());
  await refs.locator('.scv-reference-result').filter({ hasText: '共享嵌入 A ' + stamp }).click();
  await page.locator(`.scv-inline[data-canvas-host="${hostA}"]:visible`).waitFor();
  report.passed.push('reverse references locate exact canvas card', 'canvas references locate embedding documents');

  const hostC = await api('/api/filetree/createDocWithMd', { notebook, path: '/新建嵌入 C ' + stamp, markdown: 'C 前文 ' + stamp + '\n\nC 后文 ' + stamp });
  await openHost(hostC, 'C 前文 ' + stamp); await page.locator('.protyle:visible .protyle-wysiwyg').getByText('C 前文 ' + stamp, { exact: true }).click();
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await page.evaluate(() => window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').commands.find(c => c.langKey === 'embedCanvas').callback());
  const embedDialog = page.getByRole('dialog', { name: '插入或引用 Canvas', exact: true }); await embedDialog.waitFor();
  await embedDialog.getByRole('button', { name: '新建并插入', exact: true }).click();
  const destination = page.locator('.scv-destination:visible'); await destination.waitFor();
  await destination.getByLabel('保存到笔记本').selectOption(notebook);
  await destination.getByLabel('画布名称', { exact: true }).fill('新嵌入画布 ' + stamp);
  await destination.getByRole('button', { name: '放在根目录', exact: true }).click();
  await destination.getByRole('button', { name: '保存到这里', exact: true }).click();
  const createdInline = page.locator(`.scv-inline[data-canvas-host="${hostC}"]:visible`); await createdInline.waitFor();
  const createdId = await createdInline.getAttribute('data-canvas-document'); report.createdId = createdId;
  assert.notEqual(createdId, hostC); assert.notEqual(createdId, board);
  await createdInline.getByRole('button', { name: '添加便签', exact: true }).click();
  await createdInline.locator('textarea').fill('新画布正文 ' + stamp);
  await page.waitForFunction(({ createdId, hostC }) => [...window.siyuan.ws.app.plugins.find(p => p.name === 'siyuan-child-cards').inlineCanvases.values()].some(m => [...m.values()].some(v => v.anchor.dataset.canvasHost === hostC && v.controller.scene?.id === createdId && !v.controller.dirty && !v.controller.saveTask)), { createdId, hostC });
  assert.ok((await api('/api/block/getBlockKramdown', { id: createdId })).kramdown.includes('新画布正文 ' + stamp));
  assert.ok(!(await api('/api/block/getBlockKramdown', { id: hostC })).kramdown.includes('新画布正文 ' + stamp));
  report.passed.push('new canvas is created and embedded at cursor without duplicating layout in host');
  const unavailable = '20201010000000-missing';
  await api('/api/block/appendBlock', { parentID: hostC, dataType: 'markdown', data: ';;;siyuan-child-cards/canvas-reference\n' + JSON.stringify({ format: 'siyuan-child-cards-reference', version: 1, docId: unavailable }) + '\n;;;' });
  const unavailableFrame = page.locator(`.scv-inline[data-canvas-document="${unavailable}"]:visible`);
  await unavailableFrame.locator('.scv-status').filter({ hasText: '打开画布失败' }).waitFor();
  assert.ok((await api('/api/block/getBlockKramdown', { id: hostC })).kramdown.includes(unavailable));
  assert.ok((await api('/api/block/getBlockKramdown', { id: createdId })).kramdown.includes('新画布正文 ' + stamp));
  report.passed.push('unavailable source references report an error without resetting existing canvas data');
  await openHost(hostA, 'A 前文 ' + stamp); await saved();
  await canvas().getByRole('button', { name: '适应全部', exact: true }).click(); await saved();
  if (await canvas().getByRole('button', { name: '收起工具', exact: true }).count()) await canvas().getByRole('button', { name: '收起工具', exact: true }).click();
  await page.screenshot({ path: path.join(root, '.qa/canvas-features.png'), fullPage: true });
  await page.reload();
  await page.waitForFunction(() => window.siyuan?.layout?.centerLayout && window.siyuan?.ws?.app?.plugins?.some(p => p.name === 'siyuan-child-cards'));
  await openHost(hostA, 'A 前文 ' + stamp); await saved();
  assert.equal((await state()).nodes.find(n => n.id === 'note-a').text, '来自文档 B 的共享修改 ' + stamp);
  await canvas().getByRole('button', { name: '模板', exact: true }).click(); await templates.waitFor();
  await templates.getByLabel('选择画布模板').selectOption(templateId);
  await templates.getByRole('button', { name: '从模板列表移除', exact: true }).click();
  await templates.getByRole('status').filter({ hasText: '已移除模板标记' }).waitFor();
  assert.equal(await templates.locator(`option[value="${templateId}"]`).count(), 0);
  assert.equal((await api('/api/block/getBlockInfo', { id: templateId })).rootID, templateId);
  assert.ok(Object.values(await api('/api/attr/getBlockAttrs', { id: templateBlock.id })).includes(asset));
  await templates.getByRole('button', { name: '关闭', exact: true }).click();
  report.passed.push('templates survive reload and removing a template retains its native document and attachments');
  report.passed.push('embedded references and shared edits survive reload');
  await api('/api/petal/setPetalEnabled', { packageName: name, enabled: false });
  await page.waitForFunction(() => !document.querySelector('.scv-inline,.scv-root,.scv-feature-overlay'));
  report.passed.push('unload cleans up all shared views and dialogs');
  assert.deepEqual(report.errors, []);
  await fs.writeFile(path.join(root, '.qa/canvas-features-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch(async error => {
  report.failure = String(error.stack || error); console.error(error);
  if (page) {
    await page.screenshot({ path: path.join(root, '.qa/canvas-features-failure.png'), fullPage: true }).catch(() => {});
    console.error(await page.evaluate(() => document.body.innerText.slice(-1900)).catch(() => 'no page'));
  }
  await fs.writeFile(path.join(root, '.qa/canvas-features-failure.json'), JSON.stringify(report, null, 2)).catch(() => {});
  process.exitCode = 1;
}).finally(async () => { await browser?.close(); });
