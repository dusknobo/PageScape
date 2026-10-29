const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { chromium } = require('playwright');

(async () => {
  const transformed = await esbuild.transform(fs.readFileSync(path.join(__dirname, '../src/preview.ts'), 'utf8'), { loader: 'ts', format: 'cjs' });
  const script = `window.Preview = (() => {
    const module = {exports: {}};
    const require = () => ({ProtyleMethod: {
      highlightRender: root => { window.renderCalls.push(['code', root.querySelectorAll('pre.code-block > code.hljs').length]); },
      mathRender: root => {
        window.renderCalls.push(['math', root.querySelectorAll('[data-subtype="math"]').length]);
        for (const math of root.querySelectorAll('div[data-subtype="math"]')) {
          if (!math.firstElementChild) throw Error('Missing native block-math frame');
          setTimeout(() => { const cursor = document.createElement('span'); cursor.className = 'protyle-cursor'; math.firstElementChild.append(cursor); math.firstElementChild.setAttribute('contenteditable', 'false'); }, 0);
        }
      }
    }});
    ${transformed.code}
    return module.exports;
  })();`;
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    const page = await browser.newPage();
    let emptyCheckRequests = 0;
    page.on('request', request => { if (request.url().includes('scc-empty-check.invalid')) emptyCheckRequests++; });
    await page.route('**/*', route => route.abort());
    await page.setContent('<main id="target"></main>');
    await page.evaluate(() => { window.renderCalls = []; });
    await page.addScriptTag({ content: script });
    const result = await page.evaluate(async () => {
      const empty = Preview.isPreviewEmpty('<div data-type="NodeParagraph"><div contenteditable="true">\u200b </div></div>');
      const complexNonempty = !Preview.isPreviewEmpty('<div data-type="NodeCustomBlock"><script>bad()</script></div>');
      const imageNonempty = !Preview.isPreviewEmpty('<img src="assets/中文.png">');
      const mathNonempty = !Preview.isPreviewEmpty('<span data-subtype="math" data-content="x^2"></span>');
      Preview.isPreviewEmpty('<img src="https://scc-empty-check.invalid/marker.png">');
      const target = document.querySelector('#target');
      const dom = `<div id="source" data-node-id="20260101000000-aaaaaaa" data-type="NodeParagraph" onclick="bad()" style="position:fixed">
          <span data-type="block-ref" data-id="20260101000000-bbbbbbb">内部引用</span>
          <a href="javascript:bad()">危险链接</a><img src="data:image/svg+xml,bad" onerror="bad()">
          <script>bad()</script><iframe src="https://example.invalid"></iframe></div>
        <div data-type="NodeCodeBlock" class="code-block"><div class="protyle-action"><span class="protyle-action__language">cpp</span></div>
          <div class="hljs"><div class="protyle-linenumber__rows">1</div><div contenteditable="true">int main() { return 0; }</div></div></div>
        <div data-type="NodeMathBlock" data-subtype="math" data-content="x^2 + y^2"></div>`;
      const dispose = Preview.createPreviewRenderer({ dom, eof: true }, target, true);
      await new Promise(resolve => setTimeout(resolve, 25));
      const safe = !target.querySelector('script,iframe,[onclick],[onerror],[contenteditable],[data-node-id],#source,[href^="javascript:"],[src^="data:"]');
      const ref = target.querySelector('a')?.getAttribute('href');
      const code = target.querySelector('pre.code-block code')?.textContent;
      const calls = window.renderCalls;
      dispose();
      const disposed = target.children.length === 0;
      Preview.createPreviewRenderer({ dom: Array.from({ length: 15 }, (_, i) => `<p>${i}</p>`).join(''), eof: false }, target, true);
      const limited = target.firstElementChild.children.length;
      const noCursor = !target.querySelector('.protyle-cursor');
      target.replaceChildren();
      Preview.createPreviewRenderer({ dom: '<pre><code>' + 'x'.repeat(25000) + '</code></pre><span data-subtype="math" data-content="' + 'x'.repeat(5000) + '"></span><img src="https://scc-empty-check.invalid/hidden.png">', eof: true }, target, false);
      const boundedCode = target.querySelector('code').textContent.length < 19000;
      const boundedMath = !target.querySelector('[data-subtype="math"]');
      await new Promise(resolve => setTimeout(resolve, 25));
      return { empty, complexNonempty, imageNonempty, mathNonempty, safe, ref, code, calls, disposed, limited, noCursor, boundedCode, boundedMath };
    });
    for (const key of ['empty', 'complexNonempty', 'imageNonempty', 'mathNonempty', 'safe', 'disposed', 'noCursor', 'boundedCode', 'boundedMath']) assert.equal(result[key], true, key);
    assert.equal(emptyCheckRequests, 0, 'empty checks and hidden images must not request remote image URLs');
    assert.equal(result.ref, 'siyuan://blocks/20260101000000-bbbbbbb');
    assert.equal(result.code, 'int main() { return 0; }');
    assert.deepEqual(result.calls.slice(0, 2), [['code', 1], ['math', 1]]);
    assert.equal(result.limited, 10);
    console.log('Preview browser checks passed: safety, host-renderer DOM, empty detection, 10-block limit, disposal.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
