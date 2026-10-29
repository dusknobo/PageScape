import { normalizeScene } from './model';
import type { CanvasScene } from './types';

export const CANVAS_DOCUMENT_BLOCK = 'canvas-document';
export const CANVAS_DOCUMENT_ATTR = 'custom-scc-canvas';
export const CANVAS_LEGACY_ATTR = 'custom-scc-legacy-id';
export const SIYUAN_ID = /^\d{14}-[a-z0-9]{7}$/;
export interface CanvasDocumentPayload {
  format: 'siyuan-child-cards-canvas'; version: 1; scene: CanvasScene;
  legacyId?: string; migrationId?: string;
}

export function parseCanvasDocument(content: string): CanvasDocumentPayload {
  const raw: unknown = JSON.parse(content);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('画布文档内容无效');
  const value = raw as Record<string, unknown>;
  if (value.format !== 'siyuan-child-cards-canvas' || value.version !== 1) throw new Error('不支持此画布文档版本，请更新插件');
  const result: CanvasDocumentPayload = { format: 'siyuan-child-cards-canvas', version: 1, scene: normalizeScene(value.scene) };
  for (const key of ['legacyId', 'migrationId'] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(value[key])) throw new Error('画布迁移标记无效');
      result[key] = value[key];
    }
  }
  return result;
}

export function canvasDocumentContent(scene: CanvasScene, markers: { legacyId?: string; migrationId?: string } = {}): string {
  const value: CanvasDocumentPayload = { format: 'siyuan-child-cards-canvas', version: 1, scene: normalizeScene(scene), ...markers };
  // JSON stringifies embedded line breaks; note text cannot close the custom block.
  const content = JSON.stringify(value);
  parseCanvasDocument(content);
  return content;
}

export function canvasDocumentMarkdown(pluginName: string, content: string): string {
  parseCanvasDocument(content);
  return `;;;${encodeURIComponent(pluginName)}/${CANVAS_DOCUMENT_BLOCK}\n${content}\n;;;`;
}

export function extractCanvasDocumentContent(markdown: string, pluginName: string): string | undefined {
  const opening = `;;;${encodeURIComponent(pluginName)}/${CANVAS_DOCUMENT_BLOCK}`;
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== opening) return undefined;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === ';;;');
  if (end < 0) throw new Error('画布块内容不完整，未修改原文档');
  const content = lines.slice(1, end).join('\n'); parseCanvasDocument(content); return content;
}
