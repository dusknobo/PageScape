const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const base = 'http://127.0.0.1:6807';
let browser, page;
(async () => {
  await fs.mkdir(path.join(root, '.qa'), { recursive: true });
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({ viewport: { width: 1680, height: 1100 } });
  await context.request.post(base + '/api/system/loginAuth', { data: { authCode: 'child-cards-isolated-test' } });
  const api = async (route, data = {}) => { const result = await (await context.request.post(base + route, { data })).json(); assert.equal(result.code, 0, `${route}: ${result.msg}`); return result.data; };
  const workspace = await api('/api/system/getWorkspaceInfo');
  assert.equal(path.resolve(workspace.workspaceDir).toLowerCase(), path.join(root, '.test-workspace').toLowerCase(), 'Refuse to change user notes');
  if (process.env.SKIP_INSTALL !== '1') {
    await api('/api/petal/setPetalEnabled', { packageName: 'siyuan-child-cards', enabled: false });
    await fs.cp(path.join(root, 'dist'), path.join(root, '.test-workspace/data/plugins/siyuan-child-cards'), { recursive: true });
    await api('/api/petal/setPetalEnabled', { packageName: 'siyuan-child-cards', enabled: true });
  }
  page = await context.newPage(); const errors = []; const requests = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => requests.push(request.url()));
  await page.route('https://canvas-parity.invalid/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>外部网页测试</h1><p>沙箱内容</p>' }));
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.siyuan?.layout?.centerLayout && window.siyuan.ws?.app?.plugins?.some(plugin => plugin.name === 'siyuan-child-cards'), { timeout: 60000 });
  await page.locator('[data-key="dialog-changelog"] .b3-dialog__scrim').click({ position: { x: 5, y: 5 }, timeout: 1200 }).catch(() => {});
  await page.locator('#message .b3-snackbar__close').first().click({ timeout: 1200 }).catch(() => {});
  const token = Date.now();
  const notebook = (await api('/api/notebook/createNotebook', { name: 'Canvas Parity QA ' + token })).notebook.id;
  const imageBytes = Buffer.from(await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 100; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ed2116'; ctx.fillRect(0, 0, 80, 100); ctx.fillStyle = '#16ba32'; ctx.fillRect(80, 0, 80, 100); return canvas.toDataURL('image/png').split(',')[1]; }), 'base64');
  const asset = 'assets/canvas-parity-' + token + '.png';
  const uploaded = await (await context.request.post(base + '/api/file/putFile', { multipart: { path: '/data/' + asset, isDir: 'false', file: { name: asset.split('/').pop(), mimeType: 'image/png', buffer: imageBytes } } })).json();
  assert.equal(uploaded.code, 0);
  const source = await api('/api/filetree/createDocWithMd', { notebook, path: '/预览文档 ' + token, markdown: '正文预览导出测试。\n\n```js\nconst value = 42;\n```' });
  const seed = { version: 1, id: crypto.randomUUID(), title: '交互对齐测试 ' + token, revision: 'qa-revision', updatedAt: Date.now(), viewport: { x: 30, y: 30, zoom: 1 }, settings: { snapToGrid: false, snapToObjects: false, readOnly: false }, nodes: [
    { id: 'Group-main', kind: 'group', title: '动态分组', x: 0, y: 0, width: 950, height: 750, color: 'cyan' },
    { id: 'Text-A', kind: 'text', text: '# Markdown 便签\n\n**粗体导出文字**\n\n- 第一项\n- 第二项\n\n<script>window.canvasXss=1</script>', x: 30, y: 60, width: 280, height: 240, color: 'orange' },
    { id: 'Text-B', kind: 'text', text: '便签 B', x: 30, y: 390, width: 230, height: 180, color: 'green' },
    { id: 'Text-C', kind: 'text', text: '便签 C', x: 480, y: 410, width: 260, height: 180, color: 'blue' },
    { id: 'Image-one', kind: 'file', file: asset, mediaType: 'image', name: '双色图片', x: 350, y: 60, width: 220, height: 240, color: 'red' },
    { id: 'Doc-one', kind: 'doc', docId: source, title: '正文卡片', x: 620, y: 60, width: 300, height: 240, color: 'purple' },
    { id: 'Link-one', kind: 'link', url: 'https://canvas-parity.invalid/page', title: '外部网页', x: 1020, y: 60, width: 320, height: 300, color: 'yellow' },
    { id: 'Unresolved-one', kind: 'file', file: '../vault/picture.png', unresolved: true, x: 1020, y: 420, width: 260, height: 170, color: 'neutral' },
  ], edges: [{ id: 'Edge-magenta', from: 'Image-one', to: 'Text-C', fromSide: 'bottom', toSide: 'top', fromEnd: 'arrow', toEnd: 'arrow', label: '双向导出箭头', color: '#ff00ff' }] };
  const payload = { format: 'siyuan-child-cards-canvas', version: 1, scene: seed };
  const board = await api('/api/filetree/createDocWithMd', { notebook, path: '/' + seed.title, markdown: ';;;siyuan-child-cards/canvas-document\n' + JSON.stringify(payload) + '\n;;;\n{: custom-scc-canvas="1"}\n' });
  await page.evaluate(id => { void window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'siyuan-child-cards').openCanvasDocument(id); }, board);
  const ui = () => page.locator('.scv-root:visible').last();
  const card = id => ui().locator(`.scv-node[data-scv-node-id=${JSON.stringify(id)}]`);
  const scene = () => page.evaluate(id => [...window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'siyuan-child-cards').canvases.values()].find(controller => controller.scene?.id === id)?.scene, board);
  const saved = () => page.waitForFunction(id => { const controller = [...window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'siyuan-child-cards').canvases.values()].find(controller => controller.scene?.id === id); return controller && !controller.dirty && !controller.saveTask && !controller.transitionTask; }, board, { timeout: 25000 });
  await page.waitForFunction(id => [...window.siyuan.ws.app.plugins.find(plugin => plugin.name === 'siyuan-child-cards').canvases.values()].some(controller => controller.scene?.id === id && controller.element.getClientRects().length), board);
  await saved(); await ui().getByRole('button', { name: '更多工具', exact: true }).click();
  await ui().getByRole('button', { name: '适应全部', exact: true }).click(); await saved();
  const bold = () => card('Text-A').locator('.scv-note-reading').getByText(/^(粗体导出文字|真实编辑后文字)$/, { exact: true });
  await bold().waitFor();
  assert.ok(Number(await bold().evaluate(element => getComputedStyle(element).fontWeight)) >= 600);
  assert.equal(await page.evaluate(() => window.canvasXss), undefined);
  assert.equal(await card('Unresolved-one').locator('img,a,iframe').count(), 0);
  assert.ok(!(requests.some(url => url.includes('/vault/'))));
  await card('Image-one').locator('img').evaluate(image => image.decode());
  await card('Doc-one').getByText('正文预览导出测试。', { exact: true }).waitFor();
  await card('Text-A').locator('.scv-note-reading').dblclick();
  await card('Text-A').getByRole('textbox', { name: '便签内容' }).fill('# Markdown 便签\n\n**真实编辑后文字**\n\n导出必须保留中文。');
  await page.keyboard.press('Escape'); await saved();
  assert.equal(await bold().innerText(), '真实编辑后文字');
  assert.ok(Number(await bold().evaluate(element => getComputedStyle(element).fontWeight)) >= 600);
  const header = id => card(id).locator('.scv-node-header');
  async function drag(locator, dx, dy, modifiers = []) { const box = await locator.boundingBox(); assert.ok(box); for (const key of modifiers) await page.keyboard.down(key); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 10 }); await page.mouse.up(); for (const key of modifiers.reverse()) await page.keyboard.up(key); await saved(); }
  const aBefore = (await scene()).nodes.find(node => node.id === 'Text-A');
  await drag(header('Text-A'), 55, 25, ['Shift']);
  const aAfter = (await scene()).nodes.find(node => node.id === 'Text-A');
  assert.ok(aAfter.x > aBefore.x); assert.equal(aAfter.y, aBefore.y, 'Shift locks the drag axis');
  const countBeforeAlt = (await scene()).nodes.length;
  await drag(header('Text-A'), 95, 35, ['Alt']);
  assert.equal((await scene()).nodes.length, countBeforeAlt + 1);
  await ui().getByRole('button', { name: '撤销', exact: true }).click(); await saved();
  assert.equal((await scene()).nodes.length, countBeforeAlt, 'Alt-drag is one undoable operation');
  await header('Text-A').click(); await page.keyboard.press('Control+d'); await saved();
  assert.equal((await scene()).nodes.length, countBeforeAlt + 1);
  await ui().getByRole('button', { name: '撤销', exact: true }).click(); await saved();
  const sizeBefore = (await scene()).nodes.find(node => node.id === 'Image-one');
  await drag(card('Image-one').locator('.scv-node-resize'), 55, 13, ['Shift']);
  const sizeAfter = (await scene()).nodes.find(node => node.id === 'Image-one');
  assert.ok(Math.abs(sizeAfter.width / sizeAfter.height - sizeBefore.width / sizeBefore.height) < .001);
  console.log('Markdown, safe unresolved assets, duplicate/Alt-drag, axis lock and proportional resize passed');

  async function select(ids) { await ui().locator('.scv-stage').click({ position: { x: 5, y: 5 } }); await header(ids[0]).click(); for (const id of ids.slice(1)) await header(id).click({ modifiers: ['Shift'] }); }
  await select(['Text-A', 'Text-B', 'Text-C']);
  for (const kind of ['left', 'center', 'right', 'top', 'middle', 'bottom', 'row', 'column', 'grid', 'distribute-x', 'distribute-y', 'grid']) {
    await ui().getByLabel('排列所选节点').selectOption(kind); await saved();
    const nodes = (await scene()).nodes.filter(node => ['Text-A', 'Text-B', 'Text-C'].includes(node.id));
    if (['left', 'center', 'right'].includes(kind)) { const values = nodes.map(node => node.x + (kind === 'center' ? node.width / 2 : kind === 'right' ? node.width : 0)); assert.ok(Math.max(...values) - Math.min(...values) < .001); }
    if (['top', 'middle', 'bottom'].includes(kind)) { const values = nodes.map(node => node.y + (kind === 'middle' ? node.height / 2 : kind === 'bottom' ? node.height : 0)); assert.ok(Math.max(...values) - Math.min(...values) < .001); }
    if (kind.startsWith('distribute')) { const axis = kind === 'distribute-x' ? 'x' : 'y'; const size = axis === 'x' ? 'width' : 'height'; const ordered = nodes.sort((a, b) => a[axis] - b[axis]); assert.ok(Math.abs(ordered[1][axis] - ordered[0][axis] - ordered[0][size] - (ordered[2][axis] - ordered[1][axis] - ordered[1][size])) < .001); }
  }
  await ui().getByRole('button', { name: '适应全部', exact: true }).click(); await saved();
  await header('Text-A').click(); await page.keyboard.press('Shift+Digit2'); await saved();
  assert.ok((await scene()).viewport.zoom > 0); await page.keyboard.press('Shift+Digit1'); await saved();
  await card('Link-one').getByRole('button', { name: '网页预览', exact: true }).click();
  const frame = card('Link-one').locator('iframe'); await frame.waitFor();
  assert.equal((await frame.getAttribute('sandbox')).includes('allow-same-origin'), false);
  await card('Link-one').getByRole('button', { name: '网页预览', exact: true }).click(); assert.equal(await frame.count(), 0);
  console.log('All alignment/arrangement modes, selection zoom and sandbox web display passed');

  // Restore this fixture's separated cards after intentionally overlapping
  // alignment exercises so later pointer drags target visible connection ports.
  for (let index = 0; index < 12; index++) { await ui().getByRole('button', { name: '撤销', exact: true }).click(); await saved(); }
  await ui().getByRole('button', { name: '适应全部', exact: true }).click(); await saved();

  const groupBefore = (await scene()).nodes.find(node => node.id === 'Group-main');
  const insideBefore = (await scene()).nodes.find(node => node.id === 'Image-one');
  await drag(header('Group-main'), 35, 20);
  const afterGroup = await scene(); const groupAfter = afterGroup.nodes.find(node => node.id === 'Group-main'); const insideAfter = afterGroup.nodes.find(node => node.id === 'Image-one');
  assert.ok(Math.abs(insideAfter.x - insideBefore.x - (groupAfter.x - groupBefore.x)) < .001, 'Geometrically-contained nodes move with groups without stored membership');
  await ui().getByRole('button', { name: '适应全部', exact: true }).click(); await saved();
  async function dragBetween(a, b) { const source = await a.boundingBox(); const target = await b.boundingBox(); assert.ok(source && target); await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2); await page.mouse.down(); await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 }); await page.mouse.up(); await saved(); }
  const edgesBefore = (await scene()).edges.length;
  await dragBetween(card('Text-A').locator('[data-side="top"]'), card('Text-B').locator('[data-side="bottom"]'));
  const connected = (await scene()).edges.find(edge => edge.id !== 'Edge-magenta');
  assert.equal((await scene()).edges.length, edgesBefore + 1); assert.equal(connected.fromSide, 'top'); assert.equal(connected.toSide, 'bottom');
  const edge = () => ui().locator(`.scv-edge[data-edge-id=${JSON.stringify(connected.id)}]`);
  await edge().locator('path').evaluate(path => { const p = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM()); path.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: p.x, clientY: p.y })); });
  await ui().getByRole('menuitem', { name: '双向箭头', exact: true }).click(); await saved();
  assert.equal((await scene()).edges.find(edge => edge.id === connected.id).fromEnd, 'arrow');
  await dragBetween(ui().locator(`[data-edge-id=${JSON.stringify(connected.id)}][data-edge-end="to"]`), card('Text-C').locator('[data-side="left"]'));
  assert.equal((await scene()).edges.find(edge => edge.id === connected.id).to, 'Text-C');
  console.log('Dynamic groups, four-sided connections, direction menu and reconnect passed');

  async function setting(readonly) { await ui().getByRole('button', { name: '设置', exact: true }).click(); const panel = ui().getByRole('dialog', { name: '画布设置' }); await panel.getByLabel('只读画布').setChecked(readonly); await panel.getByRole('button', { name: '应用', exact: true }).click(); await saved(); }
  await setting(true); const locked = await scene();
  assert.equal(await ui().getByRole('button', { name: '添加便签', exact: true }).isDisabled(), true);
  assert.equal(await ui().getByRole('button', { name: '撤销', exact: true }).isDisabled(), true);
  await header('Text-A').click(); await page.keyboard.press('Delete'); await page.keyboard.press('Control+d'); await page.keyboard.press('Control+z');
  await ui().locator('.scv-stage').evaluate(stage => { const data = new DataTransfer(); data.setData('text/plain', 'https://must-not-add.invalid'); stage.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: data })); stage.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: data, clientX: 500, clientY: 400 })); });
  await ui().getByRole('button', { name: '+', exact: true }).click(); await saved();
  assert.deepEqual((await scene()).nodes, locked.nodes); assert.deepEqual((await scene()).edges, locked.edges);
  assert.notEqual((await scene()).viewport.zoom, locked.viewport.zoom, 'Read-only navigation still works');
  await setting(false);
  const downloadPromise = page.waitForEvent('download'); await ui().getByRole('button', { name: '导出 .canvas', exact: true }).click(); const jsonDownload = await downloadPromise;
  const jsonPath = path.join(root, '.qa', 'canvas-parity.canvas'); await jsonDownload.saveAs(jsonPath); const standard = JSON.parse(await fs.readFile(jsonPath, 'utf8')); assert.ok(standard.nodes.some(node => node.type === 'file')); assert.ok(standard.nodes.some(node => node.type === 'link'));
  await ui().getByRole('button', { name: '适应全部', exact: true }).click(); await saved();
  const pngPromise = page.waitForEvent('download', { timeout: 30000 }); await ui().getByRole('button', { name: '导出 PNG', exact: true }).click(); const pngDownload = await pngPromise;
  const pngPath = path.join(root, '.qa', 'canvas-parity.png'); await pngDownload.saveAs(pngPath); const png = await fs.readFile(pngPath);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const pixels = await page.evaluate(async base64 => { const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)); const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' })); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); const data = context.getImageData(0, 0, image.width, image.height).data; let red = 0, green = 0, dark = 0, magenta = 0; for (let i = 0; i < data.length; i += 4) { const [r, g, b, a] = data.subarray(i, i + 4); if (a < 200) continue; if (r > 180 && g < 90 && b < 90) red++; if (g > 120 && r < 100 && b < 100) green++; if (r < 80 && g < 80 && b < 80) dark++; if (r > 200 && g < 90 && b > 200) magenta++; } return { width: image.width, height: image.height, red, green, dark, magenta }; }, png.toString('base64'));
  assert.ok(pixels.red > 500 && pixels.green > 500, 'PNG contains the actual embedded two-color image'); assert.ok(pixels.dark > 100, 'PNG includes visible card text'); assert.ok(pixels.magenta > 10, 'PNG includes colored connection geometry');
  await page.screenshot({ path: path.join(root, '.qa', 'canvas-parity-ui.png'), fullPage: true });
  assert.deepEqual(errors.filter(error => /child-cards|scv-|Cannot read properties/.test(error)), []);
  await fs.writeFile(path.join(root, '.qa', 'canvas-parity-result.json'), JSON.stringify({ notebook, board, source, asset, pixels, errors, passed: ['safe Markdown read/edit', 'unresolved assets never loaded', 'proportional resize', 'axis lock', 'Alt drag copy and undo', 'duplicate selection', 'six alignments and distribution/row/column/grid', 'selection zoom', 'sandbox website', 'dynamic group membership', 'four-sided connections', 'direction/reconnect', 'read-only blocks mutations and permits navigation', 'JSON Canvas download', 'PNG actual image/text/edge pixels'] }, null, 2));
  console.log('Canvas parity UI passed', { board, pixels, errors }); await browser.close();
})().catch(async error => { console.error(error); if (page) { await page.screenshot({ path: path.join(root, '.qa', 'canvas-parity-failure.png'), fullPage: true }).catch(() => {}); console.error(await page.evaluate(() => document.body.innerText.slice(-3000)).catch(() => 'no state')); } await browser?.close().catch(() => {}); process.exitCode = 1; });
