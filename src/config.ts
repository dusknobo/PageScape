import type { GalleryConfig } from './types';

export const BLOCK_TYPE = 'child-cards';
export const DEFAULT_CONFIG: GalleryConfig = {
  version: 1, columns: 0, previewHeight: 200, showImages: true, autoRefresh: true,
};

export function parseConfig(content: string): GalleryConfig {
  const data: Partial<GalleryConfig> = JSON.parse(content || '{}');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('卡片设置格式不正确');
  if (data.version !== undefined && data.version !== 1) throw new Error('此卡片使用了更新版本的配置，请更新插件');
  return {
    version: 1,
    columns: [0, 1, 2, 3, 4].includes(Number(data.columns)) ? Number(data.columns) as GalleryConfig['columns'] : 0,
    previewHeight: Number.isFinite(data.previewHeight) ? Math.max(140, Math.min(400, Math.round(data.previewHeight!))) : 200,
    showImages: typeof data.showImages === 'boolean' ? data.showImages : true,
    autoRefresh: typeof data.autoRefresh === 'boolean' ? data.autoRefresh : true,
  };
}

export function blockMarkdown(pluginName: string): string {
  return `;;;${encodeURIComponent(pluginName)}/${BLOCK_TYPE}\n${JSON.stringify(DEFAULT_CONFIG)}\n;;;`;
}
