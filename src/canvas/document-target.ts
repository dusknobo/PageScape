import { SiyuanApi } from '../api';
import type { DocInfo } from '../types';
import { canvasRequest } from './document-api';
import type { DocNode } from './types';

export function canvasPreviewKey(node: Pick<DocNode, 'docId' | 'subpath'>): string { return `${node.docId}\0${node.subpath || ''}`; }

function headingText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const template = document.createElement('template'); template.innerHTML = value;
  return (template.content.textContent || '').trim();
}

/** Resolve only within the named document. Missing or ambiguous subpaths never silently show another block. */
export async function resolveCanvasDocumentTarget(doc: DocInfo, subpath: string | undefined, signal: AbortSignal): Promise<string> {
  if (!subpath) return doc.id;
  signal.throwIfAborted();
  let fragment: string;
  try { fragment = decodeURIComponent(subpath); } catch { throw new Error('文档定位路径编码无效'); }
  const direct = /^#\^(\d{14}-[a-z0-9]{7})$/.exec(fragment)?.[1];
  let target = direct;
  if (!target) {
    if (!fragment.startsWith('#') || fragment.startsWith('#^') || !fragment.slice(1).trim()) throw new Error('文档定位仅支持 #标题 或 #^思源块ID');
    const outline = await canvasRequest<unknown>('/api/outline/getDocOutline', { id: doc.id, notebook: doc.notebook, preview: false }, signal);
    const matches = new Set<string>(); let count = 0;
    const walk = (entries: unknown, depth: number): void => {
      if (entries === null) return;
      if (!Array.isArray(entries) || depth > 30) throw new Error('文档大纲格式无效或层级过深');
      for (const item of entries) {
        if (++count > 10000) throw new Error('文档大纲过大，请改用思源块 ID 定位');
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        if (headingText(row.name) === fragment.slice(1).trim() && typeof row.id === 'string' && /^\d{14}-[a-z0-9]{7}$/.test(row.id)) matches.add(row.id);
        if (row.children) walk(row.children, depth + 1);
      }
    };
    walk(outline, 0);
    if (!matches.size) throw new Error(`未找到定位标题“${fragment.slice(1)}”；定位路径仍保留`);
    if (matches.size > 1) throw new Error('存在多个同名标题，请使用 #^思源块ID 精确定位');
    target = [...matches][0];
  }
  const owner = await new SiyuanApi().resolveDocument(target, signal, doc.notebook);
  if (owner.id !== doc.id || owner.notebook !== doc.notebook) throw new Error('定位块不属于这篇文档，未打开其他原文');
  return target;
}
