import { Constants } from 'siyuan';
import { CanvasApiError, canvasRequest } from './document-api';
import { CANVAS_MIGRATION_BACKUPS, CANVAS_MIGRATION_MANIFEST } from './migration';
import type { CanvasMigrationIO } from './migration';

/** Raw reads preserve whitespace, encoding and every byte in legacy JSON backups. */
export function createCanvasMigrationIO(pluginName: string): CanvasMigrationIO {
  if (!/^[a-z0-9-]+$/.test(pluginName)) throw new Error('插件存储路径无效');
  const base = `/data/storage/petal/${pluginName}`;
  const legacyName = (name: string) => {
    if (!/^canvas-[a-zA-Z0-9_-]+\.json$/.test(name) || name === CANVAS_MIGRATION_MANIFEST) throw new Error('旧画布文件名无效');
    return name;
  };
  const backupPath = (run: string, name: string) => {
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(run)) throw new Error('备份批次 ID 无效');
    return `${base}/${CANVAS_MIGRATION_BACKUPS}/${run}/${legacyName(name)}`;
  };
  const read = async (path: string): Promise<Uint8Array | undefined> => {
    const response = await fetch('/api/file/getFile', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }), signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`备份读取失败（HTTP ${response.status}）`);
    if (response.status === 202) {
      const result = await response.json();
      if (result?.code === 404) return undefined;
      throw new Error(result?.msg || '备份读取失败');
    }
    return new Uint8Array(await response.arrayBuffer());
  };
  const write = async (path: string, bytes: Uint8Array): Promise<void> => {
    if (window.siyuan?.config?.readonly || window.siyuan?.isPublish) throw new Error('当前工作空间为只读，不能备份或迁移');
    const form = new FormData(); form.append('path', path); form.append('isDir', 'false'); form.append('app', Constants.SIYUAN_APPID);
    form.append('file', new Blob([Uint8Array.from(bytes).buffer], { type: 'application/json' }), path.split('/').pop()!);
    const response = await fetch('/api/file/putFile', { method: 'POST', credentials: 'same-origin', body: form, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`备份写入失败（HTTP ${response.status}）`);
    const result = await response.json(); if (result?.code !== 0) throw new Error(result?.msg || '备份写入失败');
  };
  return {
    async listLegacy() {
      try {
        const files = await canvasRequest<{ name: string; isDir: boolean }[]>('/api/file/readDir', { path: base });
        if (!Array.isArray(files)) throw new Error('旧画布目录列表无效');
        return files.filter(file => !file.isDir && file.name !== CANVAS_MIGRATION_MANIFEST && /^canvas-[a-zA-Z0-9_-]+\.json$/.test(file.name)).map(file => file.name).sort();
      } catch (error) { if (error instanceof CanvasApiError && error.code === 404) return []; throw error; }
    },
    async readLegacy(name) { const bytes = await read(`${base}/${legacyName(name)}`); if (!bytes) throw new Error(`旧画布 ${name} 已不存在`); return bytes; },
    async readBackup(run, name) { return read(backupPath(run, name)); },
    async writeBackup(run, name, bytes) {
      const path = backupPath(run, name); const existing = await read(path);
      if (existing) {
        if (existing.length !== bytes.length || existing.some((value, index) => value !== bytes[index])) throw new Error('已有备份字节不一致，未覆盖备份');
        return;
      }
      await write(path, bytes);
    },
    async readManifest() {
      const bytes = await read(`${base}/${CANVAS_MIGRATION_MANIFEST}`); if (!bytes) return undefined;
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw new Error('迁移清单损坏，未覆盖原文件'); }
    },
    async writeManifest(value) { await write(`${base}/${CANVAS_MIGRATION_MANIFEST}`, new TextEncoder().encode(JSON.stringify(value, null, 2))); },
  };
}
