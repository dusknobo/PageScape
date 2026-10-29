import type { CanvasViewOptions } from './types';

export function safeCanvasUrl(value: string, linksOnly = false): string | undefined {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f\\]/.test(value.trim())) return;
  try {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value); if (!url.username && !url.password) return url.href;
    } else if (!linksOnly && /^\/?assets\//.test(value)) {
      let decoded = value.split(/[?#]/)[0];
      for (let i = 0; i < 3; i++) decoded = decodeURIComponent(decoded);
      if (decoded.split('/').some(part => part === '.' || part === '..') || /[\\\u0000-\u001f]/.test(decoded)) return;
      return value.startsWith('/') ? value : '/' + value;
    }
  } catch { /* Keep unsupported file paths visible, but never activate them. */ }
}
export function renderNoteMarkdown(text: string, target: HTMLElement, render: CanvasViewOptions['renderPreview']): () => void {
  const releases: (() => void)[] = [];
  try {
    const lute = window.Lute.New();
    const template = document.createElement('template'); template.innerHTML = lute.Md2BlockDOM(text);
    const children = [...template.content.childNodes];
    // Feed complete blocks to the existing allowlist renderer. Chunking avoids
    // its opening-preview block limit without slicing HTML or trusting raw HTML.
    for (let index = 0; index < children.length; index += 8) {
      const source = document.createElement('div');
      for (const child of children.slice(index, index + 8)) source.append(child.cloneNode(true));
      const section = document.createElement('div'); target.append(section);
      releases.push(render({ dom: source.innerHTML, eof: true }, section, true));
    }
    if (!children.length) target.textContent = text || '双击编辑便签';
  } catch { target.textContent = text || '双击编辑便签'; }
  return () => { releases.forEach(release => release()); target.replaceChildren(); };
}
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_'); anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
