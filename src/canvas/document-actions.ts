import { SiyuanApi } from '../api';
import { canvasRequest, listCanvasNotebooks } from './document-api';
import type { DocInfo } from '../types';
import type { CanvasDestination } from './types';

function allocateDocumentId(): string {
  const date = new Date(); const two = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}-${crypto.randomUUID().replace(/-/g, '').slice(0, 7)}`;
}

export function textDocumentTitle(text: string): string {
  return (text.split(/\r?\n/).find(line => line.trim()) || '便签').replace(/^\s*#{1,6}\s+/, '').trim().slice(0, 300) || '便签';
}

/** This creates a new native document; the caller replaces its note only after verification. */
export async function createDocumentFromText(text: string, title: string, destination: CanvasDestination, signal: AbortSignal): Promise<DocInfo> {
  signal.throwIfAborted();
  if (!text.trim()) throw new Error('空便签无需转换为文档');
  if (!title.trim() || title.trim().length > 300) throw new Error('文档名称须为 1 至 300 个字符');
  const books = await listCanvasNotebooks(); signal.throwIfAborted();
  if (!books.some(book => book.id === destination.notebook)) throw new Error('目标笔记本已关闭或不可写');
  let parentPath = '';
  const api = new SiyuanApi();
  if (destination.parentId) {
    const parent = await api.resolveDocument(destination.parentId, signal);
    if (parent.id !== destination.parentId || parent.notebook !== destination.notebook) throw new Error('父文档位置已变化，请重新选择');
    parentPath = await canvasRequest<string>('/api/filetree/getHPathByID', { id: parent.id }, signal);
    if (!parentPath.startsWith('/')) throw new Error('父文档路径无效');
  }
  const id = allocateDocumentId();
  const safeTitle = title.replace(/[\\/\x00-\x1f]/g, ' ').trim();
  if (!safeTitle) throw new Error('文档名称无效');
  const created = await canvasRequest<string>('/api/filetree/createDocWithMd', {
    notebook: destination.notebook, id, path: `${parentPath}/${safeTitle}`, markdown: text,
    ...(destination.parentId ? { parentID: destination.parentId } : {}),
  }, signal);
  if (created !== id) throw new Error('创建文档返回了意外 ID；原便签已保留');
  const doc = await api.resolveDocument(id, signal);
  if (doc.id !== id || doc.notebook !== destination.notebook) throw new Error(`新文档 ${id} 位置核对失败；原便签已保留`);
  const children = await canvasRequest<{ content?: string; markdown?: string }[]>('/api/block/getChildBlocks', { id }, signal);
  if (!Array.isArray(children) || !children.some(child => child.content?.trim() || child.markdown?.trim())) {
    throw new Error(`新文档 ${id} 的正文未核实；原便签已保留，请检查文档树`);
  }
  return doc;
}
