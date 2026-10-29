import type { FileNode } from './types';

type UploadedMedia = Pick<FileNode, 'file' | 'name' | 'mediaType'>;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MEDIA_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|pdf|mp3|wav|ogg|oga|flac|m4a|aac|opus|mp4|webm|ogv|mov|m4v)$/i;

function mediaType(file: File): NonNullable<FileNode['mediaType']> {
  if (file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(file.name)) return 'image';
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf';
  if (file.type.startsWith('audio/') || /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus)$/i.test(file.name)) return 'audio';
  return 'video';
}

/** Only paths returned by SiYuan's upload API may be attached by this module. */
export function requireAssetPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('assets/')) throw new Error('上传未返回有效的思源附件路径');
  let decoded = value;
  try { for (let index = 0; index < 3; index++) { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; } }
  catch { throw new Error('思源附件路径编码无效'); }
  if (!decoded.startsWith('assets/') || /[\\\x00-\x1f:?#]/.test(decoded) || decoded.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('思源返回了不安全的附件路径');
  }
  return value;
}

/** Upload the whole batch before the caller adds any nodes; partial failures leave its scene intact. */
export async function uploadCanvasMedia(files: File[], documentId: string, signal: AbortSignal): Promise<UploadedMedia[]> {
  signal.throwIfAborted();
  if (!/^\d{14}-[a-z0-9]{7}$/.test(documentId)) throw new Error('画布文档 ID 无效');
  if (!files.length || files.length > 20) throw new Error('请一次选择 1 至 20 个媒体文件');
  for (const file of files) {
    if (!(file instanceof File) || !MEDIA_EXTENSIONS.test(file.name)) throw new Error('请选择图片、PDF、音频或视频文件');
    if (!file.size || file.size > MAX_FILE_BYTES) throw new Error(`文件“${file.name}”为空或超过 200 MB`);
  }
  const uploaded: UploadedMedia[] = [];
  for (const source of files) {
    signal.throwIfAborted();
    const name = source.name.split(/[\\/]/).at(-1)!.replace(/[\x00-\x1f]/g, ' ').trim();
    if (!name) throw new Error('文件名称无效');
    const file = source.name === name ? source : new File([source], name, { type: source.type, lastModified: source.lastModified });
    const form = new FormData(); form.append('id', documentId); form.append('file[]', file, name);
    const response = await fetch('/api/asset/upload', {
      method: 'POST', credentials: 'same-origin', body: form,
      signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
    });
    if (!response.ok) throw new Error(`附件上传失败（HTTP ${response.status}）`);
    const result = await response.json() as { code?: number; msg?: string; data?: { succFiles?: { index: number; path: string }[]; succMap?: Record<string, string>; errFiles?: string[]; failedFiles?: unknown[] } };
    signal.throwIfAborted();
    if (result.code !== 0 || !result.data || result.data.errFiles?.length || result.data.failedFiles?.length) throw new Error(result.msg || `文件“${name}”上传失败`);
    const values = Object.values(result.data.succMap || {});
    const uploadedPath = result.data.succFiles?.find(value => value.index === 0)?.path || result.data.succMap?.[name] || (values.length === 1 ? values[0] : undefined);
    uploaded.push({ file: requireAssetPath(uploadedPath), name, mediaType: mediaType(file) });
  }
  return uploaded;
}
