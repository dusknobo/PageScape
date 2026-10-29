const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const base = 'http://127.0.0.1:6807';
let activePage;
let activeBrowser;

(async () => {
  await fs.mkdir(path.join(root, '.qa'), { recursive:true });
  const browser = await chromium.launch({ headless:true, channel:'msedge' });
  activeBrowser=browser;
  const context = await browser.newContext({ viewport:{width:1440,height:1000}, userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36' });
  const login = await context.request.post(base + '/api/system/loginAuth', {data:{authCode:'child-cards-isolated-test'}});
  assert.equal((await login.json()).code, 0);
  async function api(route, data = {}) {
    const response = await context.request.post(base + route, {data});
    const result = await response.json();
    assert.equal(result.code, 0, `${route}: ${result.msg}`);
    return result.data;
  }
  const workspace = await api('/api/system/getWorkspaceInfo');
  assert.equal(path.resolve(workspace.workspaceDir).toLowerCase(), path.join(root,'.test-workspace').toLowerCase(), 'Refuse to mutate any user workspace');
  await api('/api/setting/setBazaar',{trust:true,petalDisabled:false});
  await fs.mkdir(path.join(root,'.test-workspace/data/plugins/siyuan-child-cards'), {recursive:true});
  await fs.cp(path.join(root,'dist'), path.join(root,'.test-workspace/data/plugins/siyuan-child-cards'), {recursive:true});
  await api('/api/petal/setPetalEnabled',{packageName:'siyuan-child-cards',enabled:true});
  const notebook = (await api('/api/notebook/createNotebook',{name:'Cards UI '+Date.now()})).notebook.id;
  const config = {version:1,columns:0,previewHeight:200,showImages:true,autoRefresh:true};
  const parent = await api('/api/filetree/createDocWithMd',{notebook,path:'/OpenFOAM',markdown:'从基础数据结构到有限体积计算，按下面的章节展开。\n\n;;;siyuan-child-cards/child-cards\n'+JSON.stringify(config)+'\n;;;\n\n这里继续记录当前文档的正文。'});
  const children = [];
  const contents = [
    'OpenFOAM 编程路线：\n\n```cpp\n// C++ 必要子集\nField<scalar> values(10, 0.0);\n// OpenFOAM 数据结构\n// wmake 与用户程序\n// 场运算与有限体积矩阵\n// 运行时选择机制\n// functionObject\n// fvModel\n// 边界条件\n// 物性与子模型\n```',
    '以 OpenFOAM Foundation v14 为主。核心数据结构是一套多层类型系统。\n\n- 基础数值类型\n- 通用容器\n- 数值场\n\n$$\n\\nabla \\cdot U=0\n$$',
    '基本关系\n\n```cpp\nPrimitiveField / Field<Type>\n        |\n        | + mesh + dimensions\n        v\nDimensionedField<Type, GeoMesh>\n        |\n        | + boundaryField\n        v\nGeometricField<Type, PatchField, GeoMesh>\n```',
    '', ''
  ];
  const names = ['01 序言 LearnMap','02 基础数据结构','03 Field 体系','04 fvMesh 体系','05 场代数'];
  for (let i=0;i<names.length;i++) children.push(await api('/api/filetree/createDocWithMd',{notebook,path:'/OpenFOAM/'+names[i],markdown:contents[i]}));
  const grandchild = await api('/api/filetree/createDocWithMd',{notebook,path:'/OpenFOAM/'+names[3]+'/4.1 fvMesh 概括',markdown:'网格几何与有限体积离散。'});
  const page = await context.newPage();
  activePage=page;
  const errors = [];
  page.on('pageerror', e=>errors.push(e.message));
  await page.goto(base+'/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.siyuan?.layout?.centerLayout && window.siyuan?.config?.bazaar && window.siyuan.ws?.app,{timeout:60000});
  console.log('App booted', await page.evaluate(()=>({bazaar:window.siyuan.config.bazaar,plugins:window.siyuan.ws.app?.plugins?.map(p=>p.name)})));
  await page.waitForFunction(()=>window.siyuan.ws.app?.plugins?.some(p=>p.name==='siyuan-child-cards'),{timeout:30000});
  await page.locator('[data-key="dialog-changelog"] .b3-dialog__scrim').click({position:{x:5,y:5},timeout:3000}).catch(()=>{});
  await page.locator('#message .b3-snackbar__close').first().click({timeout:3000}).catch(()=>{});
  async function open(id) {
    await page.waitForFunction(()=>window.siyuan.layout?.centerLayout,{timeout:30000});
    await page.evaluate(id=>window.siyuan.ws.app.plugins.find(p=>p.name==='siyuan-child-cards').openDocument(id),id);
  }
  await open(parent);
  const gallery = page.locator('.protyle:not(.fn__none) .scc-root').last();
  await gallery.waitFor({timeout:30000});
  await gallery.locator('.scc-card').nth(4).waitFor();
  await page.waitForFunction(()=>!document.querySelector('.scc-card-loading'),{timeout:15000});
  assert.equal(await gallery.locator('.scc-card').count(),5);
  assert.equal(await gallery.locator('.scc-child-link').count(),1,'empty page shows grandchild');
  assert.equal(await gallery.locator('.scc-card-empty').count(),1,'empty leaf shows placeholder');
  assert.ok(await gallery.locator('pre code').count() >= 2,'code preserved');
  const mathRendered=await gallery.locator('.katex').first().waitFor({timeout:3000}).then(()=>true,()=>false);
  console.log('Initial cards ready; math rendered:',mathRendered);
  await page.screenshot({path:path.join(root,'.qa/actual-siyuan.png'),fullPage:true});
  const rows = await gallery.locator('.scc-card').evaluateAll(nodes=>nodes.map(n=>({top:Math.round(n.getBoundingClientRect().top),width:Math.round(n.getBoundingClientRect().width)})));
  const contentBlock = (await api('/api/block/getChildBlocks',{id:children[0]}))[0].id;
  const marker = '自动更新验证 '+Date.now();
  await api('/api/block/updateBlock',{id:contentBlock,dataType:'markdown',data:marker});
  const started=Date.now();
  await gallery.getByText(marker,{exact:true}).waitFor({timeout:10000});
  const refreshMs=Date.now()-started;
  await api('/api/filetree/renameDocByID',{id:children[4],title:'05 场代数 已改名'});
  await gallery.locator('.scc-card-name').filter({hasText:'05 场代数 已改名'}).waitFor({timeout:10000});
  const extra=await api('/api/filetree/createDocWithMd',{notebook,path:'/OpenFOAM/06 新增子页',markdown:'新增卡片内容'});
  await gallery.locator('.scc-card').nth(5).waitFor({timeout:10000});
  const custom={id:await gallery.evaluate(n=>n.closest('[data-type="NodeCustomBlock"]').getAttribute('data-node-id'))};
  await gallery.getByRole('button',{name:'设置',exact:true}).click();
  await gallery.locator('select').selectOption('2');
  await gallery.getByRole('button',{name:'应用',exact:true}).click();
  await page.locator(`[data-node-id="${custom.id}"] .scc-root[data-columns="2"]`).waitFor({timeout:10000});
  const blocks=await api('/api/block/getChildBlocks',{id:parent});
  assert.ok(blocks.some(b=>b.id===custom.id),`native custom block persisted: ${custom.id} / ${JSON.stringify(blocks)}`);
  let kramdown;
  const saveDeadline=Date.now()+6000;
  do {
    kramdown=await api('/api/block/getBlockKramdown',{id:custom.id});
    if(kramdown.kramdown.includes('"columns":2')) break;
    await page.waitForTimeout(100);
  } while(Date.now()<saveDeadline);
  assert.ok(kramdown.kramdown.includes('"columns":2'),`settings persisted in block: ${JSON.stringify(kramdown)}`);
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.siyuan?.ws?.app?.plugins?.some(p=>p.name==='siyuan-child-cards'),{timeout:30000});
  await open(parent);
  await page.locator(`[data-node-id="${custom.id}"] .scc-root[data-columns="2"]`).last().waitFor({timeout:15000});
  const other=await api('/api/filetree/createDocWithMd',{notebook,path:'/Other source',markdown:'另一个父文档。'});
  await api('/api/filetree/createDocWithMd',{notebook,path:'/Other source/另一组子页',markdown:'来自新父文档的内容'});
  await api('/api/block/moveBlock',{id:custom.id,parentID:other});
  await open(other);
  const moved=page.locator('.protyle:not(.fn__none) .scc-root').last();
  await moved.getByText('来自新父文档的内容',{exact:true}).waitFor({timeout:15000});
  assert.equal(await moved.locator('.scc-card').count(),1,'moved block resolves new parent');
  const beforeDisable=await page.evaluate(()=>window.siyuan.ws.app.plugins.find(p=>p.name==='siyuan-child-cards').views.size);
  await api('/api/petal/setPetalEnabled',{packageName:'siyuan-child-cards',enabled:false});
  await page.waitForFunction(()=>!window.siyuan.ws.app.plugins.some(p=>p.name==='siyuan-child-cards'),{timeout:15000});
  assert.equal(await page.locator('.scc-root').count(),0,'disable cleans all views');
  const pluginErrors=errors.filter(message=>/child-cards|scc-|Preview|GalleryController|Cannot read properties/.test(message));
  assert.deepEqual(pluginErrors,[]);
  await fs.writeFile(path.join(root,'.qa/integration.json'),JSON.stringify({parent,children,grandchild,notebook,extra,rows,refreshMs,beforeDisable,mathRendered,errors,passed:['native custom block','rich code','empty child links','live body update','rename','new document','settings persistence','reload','cross-document move','disable cleanup']},null,2));
  assert.equal(mathRendered,true,'real host formula renderer');
  console.log('Integration passed',JSON.stringify({refreshMs,rows,beforeDisable,errors}));
  await context.storageState({path:path.join(root,'.qa/browser-state.json')});
  await browser.close();
})().catch(async error=>{
  console.error(error);
  if(activePage) {
    await activePage.screenshot({path:path.join(root,'.qa/failure.png'),fullPage:true}).catch(()=>{});
    console.error('Failure state',await activePage.evaluate(()=>({body:document.body.innerText.slice(-2000),plugins:window.siyuan?.ws?.app?.plugins?.map(p=>p.name)})).catch(()=>null));
  }
  if(activeBrowser) await activeBrowser.close().catch(()=>{});
  process.exit(1);
});
