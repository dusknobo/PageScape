import { ProtyleMethod } from 'siyuan';
import type { PreviewData } from './types';

const MAX_BLOCKS = 10;
const MAX_CODE_CHARS = 18000;
const MAX_MATH_CHARS = 4000;
const MAX_TEXT_CHARS = 24000;
const BLOCK_ID = /^\d{14}-[a-z0-9]{7}$/;
const EMPTY_TEXT = /[\s\u200b-\u200f\u2028\u2029\u2060\ufeff]/g;
const ALLOWED_TAGS = new Set([
  'DIV', 'SPAN', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'STRONG', 'B', 'EM', 'I',
  'S', 'DEL', 'U', 'MARK', 'SUP', 'SUB', 'SMALL', 'KBD', 'CODE', 'PRE', 'BLOCKQUOTE',
  'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'BR', 'HR',
  'A', 'IMG',
]);
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'BASE', 'NOSCRIPT', 'TEMPLATE']);
const COMPLEX: Record<string, string> = {
  NodeCustomBlock: '自定义内容', NodeBlockQueryEmbed: '嵌入查询', NodeIFrame: '嵌入页面',
  NodeWidget: '挂件 / 白板', NodeAttributeView: '数据库', NodeHTMLBlock: 'HTML 内容',
  NodeVideo: '视频', NodeAudio: '音频',
};
const UI_SELECTOR = '.protyle-attr,.protyle-action,.protyle-icons,.protyle-icon,' +
  '.protyle-gutters,.protyle-linenumber__rows,.protyle-action__language';

function hasText(value: string | null): boolean {
  return Boolean(value?.replace(EMPTY_TEXT, ''));
}

/** Relative asset paths must stay inside SiYuan's asset endpoint. */
function safeUrl(value: string, image = false): string | undefined {
  const url = value.trim();
  if (!url || /[\u0000-\u001f\u007f\\]/.test(url)) return;
  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      if (!parsed.username && !parsed.password && ['https:', 'http:'].includes(parsed.protocol)) return parsed.href;
    } catch { /* Invalid URLs are left as text, never activated. */ }
    return;
  }
  if (/^\/?assets\//.test(url)) {
    try {
      let path = url.split(/[?#]/, 1)[0];
      for (let i = 0; i < 3; i++) {
        const decoded = decodeURIComponent(path);
        if (decoded === path) break;
        path = decoded;
      }
      if (/[\\\u0000-\u001f\u007f]/.test(path) || path.split('/').some(part => part === '..' || part === '.')) return;
      return url.startsWith('/') ? url : '/' + url;
    } catch { return; }
  }
  if (!image && /^siyuan:\/\/blocks\/\d{14}-[a-z0-9]{7}(?:[?#][^\s]*)?$/.test(url)) return url;
  if (!image && /^mailto:[^\s<>]+$/i.test(url)) return url;
  return;
}

function placeholder(label: string): HTMLElement {
  const result = document.createElement('p');
  result.className = 'scc-preview-placeholder';
  result.textContent = `〔${label}：打开文档查看〕`;
  return result;
}

function codePreview(source: Element): HTMLElement {
  const highlighted = source.matches('.hljs') ? source : source.querySelector('.hljs');
  const editable = highlighted?.querySelector('[contenteditable]');
  const existingCode = source.matches('code') ? source : source.querySelector('pre code');
  const text = existingCode?.textContent ?? editable?.textContent ??
    highlighted?.lastElementChild?.textContent ?? highlighted?.textContent ?? source.textContent ?? '';
  const language = source.getAttribute('data-language') ?? source.querySelector('[data-language]')?.getAttribute('data-language') ??
    source.querySelector('.protyle-action__language')?.textContent ??
    existingCode?.className.match(/(?:^|\s)language-([\w+-]+)/)?.[1] ?? 'plaintext';
  const pre = document.createElement('pre');
  pre.className = 'code-block scc-preview-code';
  pre.setAttribute('data-language', language.trim().slice(0, 64));
  pre.setAttribute('linenumber', 'false');
  pre.setAttribute('linewrap', 'true');
  pre.style.maxWidth = '100%';
  pre.style.overflow = 'hidden';
  const code = document.createElement('code');
  code.className = 'hljs';
  code.textContent = text.length > MAX_CODE_CHARS ? text.slice(0, MAX_CODE_CHARS) + '\n…（预览已截断，打开文档查看完整代码）' : text;
  pre.append(code);
  return pre;
}

function mathPreview(source: Element): HTMLElement {
  const expression = source.getAttribute('data-content') ?? source.textContent ?? '';
  const block = source.getAttribute('data-type') === 'NodeMathBlock' || source.tagName === 'DIV';
  const result = document.createElement(block ? 'div' : 'span');
  result.className = 'scc-preview-math';
  if (expression.length > MAX_MATH_CHARS) {
    result.textContent = expression.slice(0, MAX_MATH_CHARS) + '…（公式较长，请打开文档查看）';
    return result;
  }
  // Even older host versions must not turn formula commands into links or HTML.
  if (/\\(?:href|url|includegraphics|html(?:Class|Id|Style|Data))\b/i.test(expression)) {
    result.textContent = expression;
    return result;
  }
  result.setAttribute('data-subtype', 'math');
  result.setAttribute('data-content', expression);
  // SiYuan 3.8.3 genRenderFrame writes into the block formula's first child.
  // Supplying only a text node makes that official renderer throw before KaTeX.
  if (block) {
    const frame = document.createElement('div');
    frame.textContent = expression;
    result.append(frame);
  } else result.textContent = expression;
  result.style.maxWidth = '100%';
  result.style.overflow = 'hidden';
  return result;
}

/** Rebuild from an allowlist rather than sanitizing and reinserting editor HTML. */
function sanitize(node: Node, showImages: boolean): Node | null {
  if (node.nodeType === Node.TEXT_NODE) return document.createTextNode((node.textContent ?? '').slice(0, MAX_TEXT_CHARS));
  if (!(node instanceof Element)) return null;
  const type = node.getAttribute('data-type') ?? '';
  if (COMPLEX[type]) return placeholder(COMPLEX[type]);
  if (DROP_TAGS.has(node.tagName) || node.matches(UI_SELECTOR)) return null;
  if (['IFRAME', 'OBJECT', 'EMBED', 'CANVAS', 'VIDEO', 'AUDIO'].includes(node.tagName)) return placeholder('嵌入内容');
  if (type === 'NodeCodeBlock' || node.matches('pre,.code-block')) return codePreview(node);
  if (type === 'NodeMathBlock' || node.getAttribute('data-subtype') === 'math') return mathPreview(node);
  if (node.tagName === 'IMG') {
    if (!showImages) return placeholder('图片');
    const src = safeUrl(node.getAttribute('src') ?? '', true);
    if (!src) return placeholder('图片暂不可预览');
    const img = document.createElement('img');
    img.src = src;
    img.alt = node.getAttribute('alt') ?? '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
    return img;
  }
  const marks = type.split(' ');
  let tag = ALLOWED_TAGS.has(node.tagName) ? node.tagName.toLowerCase() : 'span';
  if (type === 'NodeList') tag = node.getAttribute('data-subtype') === 'o' ? 'ol' : 'ul';
  else if (type === 'NodeListItem') tag = 'li';
  else if (type === 'NodeBlockquote') tag = 'blockquote';
  else if (type === 'NodeThematicBreak') tag = 'hr';
  else if (type === 'NodeHeading') tag = /^h[1-6]$/.test(node.getAttribute('data-subtype') ?? '') ? node.getAttribute('data-subtype')! : 'h3';
  const refId = node.getAttribute('data-id') ?? '';
  const href = marks.includes('block-ref') && BLOCK_ID.test(refId) ? `siyuan://blocks/${refId}` :
    safeUrl(node.getAttribute('href') ?? node.getAttribute('data-href') ?? '');
  if (node.tagName === 'A' || marks.includes('a') || marks.includes('block-ref')) tag = href ? 'a' : 'span';
  const result = document.createElement(tag);
  // No original IDs, editing attributes, styles, arbitrary classes or event handlers survive.
  if (href && tag === 'a') {
    result.setAttribute('href', href);
    result.setAttribute('rel', 'noopener noreferrer');
  }
  const title = node.getAttribute('title');
  if (title) result.setAttribute('title', title.slice(0, 500));
  for (const attr of ['colspan', 'rowspan', 'start']) {
    const value = node.getAttribute(attr);
    if (value && /^\d{1,3}$/.test(value)) result.setAttribute(attr, value);
  }
  if (marks.includes('strong')) result.style.fontWeight = 'bold';
  if (marks.includes('em')) result.style.fontStyle = 'italic';
  if (marks.includes('u')) result.style.textDecoration = 'underline';
  if (marks.includes('s')) result.style.textDecoration = 'line-through';
  if (marks.includes('mark')) result.classList.add('scc-preview-mark');
  if (marks.includes('code') && !marks.includes('block-ref')) {
    const code = document.createElement('code');
    code.textContent = node.textContent;
    result.append(code);
  } else {
    for (const child of node.childNodes) {
      const safe = sanitize(child, showImages);
      if (safe) result.append(safe);
    }
  }
  return result;
}

function isSubstantial(node: Node): boolean {
  if (hasText(node.textContent)) return true;
  return node instanceof Element && (node.matches('img,[data-subtype="math"],.scc-preview-placeholder,hr') ||
    Boolean(node.querySelector('img,[data-subtype="math"],.scc-preview-placeholder,hr')));
}

function topNodes(dom: string): Node[] {
  const template = document.createElement('template');
  template.innerHTML = dom;
  const nodes = [...template.content.childNodes].filter(node => node.nodeType !== Node.TEXT_NODE || hasText(node.textContent));
  if (nodes.length === 1 && nodes[0] instanceof Element &&
    (nodes[0].getAttribute('data-type') === 'NodeDocument' || nodes[0].classList.contains('protyle-wysiwyg'))) {
    return [...nodes[0].childNodes];
  }
  return nodes;
}

export function isPreviewEmpty(dom: string): boolean {
  return !topNodes(dom).some(node => {
    // Emptiness checks must not activate image URLs, including when images are hidden.
    const safe = sanitize(node, false);
    return safe !== null && isSubstantial(safe);
  });
}

export function createPreviewRenderer(preview: PreviewData, target: HTMLElement, showImages: boolean): () => void {
  const body = document.createElement('div');
  body.className = 'scc-preview-body b3-typography';
  body.setAttribute('data-protyle-lite-render', 'safe');
  body.style.minWidth = '0';
  body.style.maxWidth = '100%';
  body.style.overflow = 'hidden';
  body.style.overflowWrap = 'anywhere';
  let count = 0;
  for (const node of topNodes(preview.dom)) {
    const safe = sanitize(node, showImages);
    if (!safe || !isSubstantial(safe)) continue;
    body.append(safe);
    if (++count === MAX_BLOCKS) break;
  }
  const events = new AbortController();
  for (const image of body.querySelectorAll('img')) {
    image.addEventListener('error', () => image.replaceWith(placeholder('图片暂不可用')), { once: true, signal: events.signal });
  }
  target.append(body);
  let disposed = false;
  const removeEditorAffordances = () => {
    for (const editable of body.querySelectorAll('[contenteditable]')) editable.removeAttribute('contenteditable');
    for (const cursor of body.querySelectorAll('.protyle-cursor')) cursor.remove();
  };
  // Some host renderers return void while loading their runtime asynchronously.
  const observer = new MutationObserver(removeEditorAffordances);
  observer.observe(body, { subtree: true, childList: true, attributes: true, attributeFilter: ['contenteditable'] });
  // These are read-only render helpers; no editor, block IDs or transactions are created.
  try { ProtyleMethod.highlightRender(body); } catch { /* Plain code remains readable. */ }
  try {
    const rendered = ProtyleMethod.mathRender(body);
    void Promise.resolve(rendered).catch(() => undefined).then(() => {
      if (disposed) return;
      removeEditorAffordances();
    });
  } catch { /* Plain formula remains readable. */ }
  return () => {
    disposed = true;
    observer.disconnect();
    events.abort();
    body.remove();
  };
}
