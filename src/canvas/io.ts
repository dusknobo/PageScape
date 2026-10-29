import { Constants } from 'siyuan';
import type { CanvasStorageIO } from './types';

/** Fresh reads are required for conflict detection; Plugin.loadData can return old cache on failure. */
export function createCanvasIO(pluginName: string): CanvasStorageIO {
  if (!/^[a-zA-Z0-9-]+$/.test(pluginName)) throw new Error('画布插件路径无效');
  const pathFor = (name: string) => {
    if (!/^canvas-[a-zA-Z0-9_-]+\.json$/.test(name)) throw new Error('画布文件名无效');
    return `/data/storage/petal/${pluginName}/${name}`;
  };
  return {
    async read(name) {
      const response = await fetch('/api/file/getFile', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: pathFor(name) }), signal: AbortSignal.timeout(8000),
      });
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`读取画布失败（HTTP ${response.status}）`);
      let value: unknown;
      try { value = JSON.parse(await response.text()); }
      catch { throw new Error('画布文件损坏，已保留原文件，请从备份恢复'); }
      if (response.status === 202 && value && typeof value === 'object' && (value as { code?: unknown }).code === 404) return undefined;
      if (response.status === 202 || (value && typeof value === 'object' && 'code' in value && Number((value as { code: unknown }).code) !== 0)) {
        throw new Error(String((value as { msg?: unknown }).msg || '无法读取画布文件'));
      }
      return value;
    },
    async write(name, value) {
      if (window.siyuan.config?.readonly || window.siyuan.isPublish) throw new Error('当前工作空间为只读，无法保存画布');
      const form = new FormData();
      form.append('path', pathFor(name));
      form.append('file', new Blob([JSON.stringify(value)], { type: 'application/json' }), name);
      form.append('isDir', 'false');
      form.append('app', Constants.SIYUAN_APPID);
      const response = await fetch('/api/file/putFile', {
        method: 'POST', credentials: 'same-origin', body: form, signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`保存画布失败（HTTP ${response.status}）`);
      const result = await response.json();
      if (result.code !== 0) throw new Error(result.msg || '画布未能保存');
    },
  };
}
