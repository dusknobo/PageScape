const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const base = 'http://127.0.0.1:6807';

(async () => {
  const browser = await chromium.launch({headless:true,channel:'msedge'});
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  const page = await context.newPage();
  let release;
  const gate = new Promise(resolve=>{release=resolve});
  try {
    await context.request.post(base+'/api/system/loginAuth',{data:{authCode:'child-cards-isolated-test'}});
    async function api(route,data={}) {
      const result=await (await context.request.post(base+route,{data})).json();
      assert.equal(result.code,0,`${route}: ${result.msg}`);
      return result.data;
    }
    const info=await api('/api/system/getWorkspaceInfo');
    assert.equal(path.resolve(info.workspaceDir).toLowerCase(),path.join(root,'.test-workspace').toLowerCase());
    await fs.cp(path.join(root,'dist'),path.join(root,'.test-workspace/data/plugins/PageScape'),{recursive:true});
    await api('/api/setting/setBazaar',{trust:true,petalDisabled:false});
    await api('/api/petal/setPetalEnabled',{packageName:'PageScape',enabled:true});
    const notebook=(await api('/api/notebook/createNotebook',{name:'Insertion race '+Date.now()})).notebook.id;
    const intro='在这里插入卡片 '+Date.now();
    const parent=await api('/api/filetree/createDocWithMd',{notebook,path:'/Parent',markdown:intro});
    await api('/api/filetree/createDocWithMd',{notebook,path:'/Parent/Child',markdown:'新块保存前也可以显示子页面。'});
    await page.goto(base+'/',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.siyuan?.layout?.centerLayout && window.siyuan.ws?.app?.plugins?.some(p=>p.name==='PageScape'));
    await page.evaluate(id=>window.siyuan.ws.app.plugins.find(p=>p.name==='PageScape').openDocument(id),parent);
    await page.locator('.protyle:visible').getByText(intro,{exact:true}).last().click();
    let holding=true;
    let heldTransactions=0;
    await page.route('**/api/transactions',async route=>{
      if(holding) {heldTransactions++;await gate;}
      await route.continue();
    });
    await page.evaluate(()=>window.siyuan.ws.app.plugins.find(p=>p.name==='PageScape').commands.find(c=>c.langKey==='insertChildCards').callback());
    const gallery=page.locator('.protyle:visible .scc-root').last();
    await gallery.waitFor();
    if(process.argv.includes('--baseline')) {
      await gallery.getByText(/加载失败：block not found/).waitFor({timeout:5000});
      console.log('Baseline reproduced: new editor block is queried before its transaction is saved.');
    } else {
      await gallery.getByText('新块保存前也可以显示子页面。',{exact:true}).waitFor({timeout:5000});
      assert.equal(await gallery.locator('.scc-status-error').count(),0);
      console.log('Insertion regression passed: preview available before new block persistence.');
    }
    assert.ok(heldTransactions>0,'test must exercise an uncommitted editor insertion');
    holding=false;release();
    await page.waitForTimeout(400);
    if(!process.argv.includes('--baseline')) {
      await gallery.getByRole('button',{name:'设置',exact:true}).click();
      await gallery.getByLabel('自动更新',{exact:true}).uncheck();
      await gallery.getByRole('button',{name:'应用',exact:true}).click();
      await page.waitForFunction(()=>{
        const roots=[...document.querySelectorAll('.protyle .scc-root')].filter(n=>n.getClientRects().length);
        const block=roots.at(-1)?.closest('[data-type="NodeCustomBlock"]');
        return block && JSON.parse(block.getAttribute('data-content')).autoRefresh===false;
      });
      let failOnce=true;
      await page.route('**/api/block/getBlockInfo',async route=>{
        if(failOnce && route.request().postDataJSON().id===parent) {
          failOnce=false;
          await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({code:3,msg:'block not found or its encrypted notebook is locked',data:null})});
        } else await route.continue();
      });
      await gallery.getByRole('button',{name:'刷新子页卡片',exact:true}).click();
      await gallery.locator('.scc-status-error').waitFor();
      await api('/api/block/appendBlock',{parentID:parent,dataType:'markdown',data:'父文档保存后恢复首次加载。'});
      await gallery.locator('.scc-status-error').waitFor({state:'detached',timeout:5000});
      await gallery.getByText('新块保存前也可以显示子页面。',{exact:true}).waitFor();
      console.log('Recovery regression passed: host save recovers a failed source read with automatic updates disabled.');
      await fs.writeFile(path.join(root,'.qa/insertion-result.json'),JSON.stringify({version:'0.1.1',heldTransactions,passed:['new editor insertion before transaction persistence','host save recovery with autoRefresh=false']},null,2));
    }
    await page.screenshot({path:path.join(root,'.qa/insertion.png'),fullPage:true});
  } finally {release();await browser.close();}
})().catch(error=>{console.error(error);process.exit(1)});
