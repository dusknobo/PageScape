import { build } from 'esbuild';
import { chromium } from 'playwright';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, '.test-build', 'docs-demo');
await mkdir(output, { recursive: true }); await mkdir(path.join(root, 'docs/images'), { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['scripts/demo.ts'], bundle: true, outfile: path.join(output, 'demo.js'), platform: 'browser', target: 'es2022' });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 920 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>PageScape demonstration</title><style>
    :root{--b3-theme-primary:#3575d3;--b3-theme-background:#fff;--b3-theme-surface:#f6f8fb;--b3-theme-on-background:#23354a;--b3-theme-on-surface:#718096;--b3-border-color:#dce4ed;--b3-font-family:system-ui,"Microsoft YaHei",sans-serif}
    body{margin:0;background:#eef3f8;font-family:var(--b3-font-family);color:#23354a;padding:28px}
    header.demo-brand{display:flex;align-items:center;justify-content:space-between;margin:0 4px 20px}
    h1{font-size:26px;letter-spacing:.5px;margin:0 0 7px}header p{margin:0;font-size:14px;color:#718096}
    .demo-badge{padding:7px 13px;border:1px solid #c8d7eb;border-radius:20px;background:#f9fbff;font-size:12px;color:#3d6484}
    #canvas{height:780px;border:1px solid #d9e2ed;border-radius:12px;overflow:hidden;background:white;box-shadow:0 10px 32px #20385c0b}
    .demo-preview{font-size:15px;line-height:1.7}.demo-preview p{margin:0 0 10px}.demo-preview ul{padding-left:20px;margin:0}
  </style><header class="demo-brand"><div><h1>页境 · PageScape</h1><p>让页面展开，让知识相连。</p></div><span class="demo-badge">文档卡片 × 共享画布</span></header><main id="canvas"></main></html>`);
  await page.addStyleTag({ content: await readFile(path.join(root, 'src/canvas/styles.css'), 'utf8') });
  await page.addScriptTag({ path: path.join(output, 'demo.js') });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(root, 'docs/images/overview.png'), fullPage: true });
  await copyFile(path.join(root, 'docs/images/overview.png'), path.join(root, 'preview.png'));
  console.log('Generated docs/images/overview.png and preview.png from the real canvas view and authored demo content.');
} finally { await browser.close(); }
