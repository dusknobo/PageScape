import type { CanvasEdge, CanvasNode, CanvasScene, CanvasSettings, NodeColor, NodeEnd, NodeSide } from './types';

const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const DOC_ID = /^\d{14}-[a-z0-9]{7}$/;
const COLORS = new Set<NodeColor>(['neutral', 'red', 'blue', 'green', 'orange', 'yellow', 'cyan', 'purple']);
export const DEFAULT_CANVAS_SETTINGS: Readonly<Required<CanvasSettings>> = Object.freeze({ snapToGrid: false, snapToObjects: true, readOnly: false });
const MAX_NODES = 2_000;
const MAX_EDGES = 5_000;
const MAX_TITLE = 300;
const MAX_TEXT = 50_000;
const MAX_TOTAL_TEXT = 2_000_000;
const MAX_COORDINATE = 10_000_000;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式无效`);
  return value as Record<string, unknown>;
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`${label}无效`);
  return value;
}

function text(value: unknown, label: string, limit: number, fallback = ''): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error(`${label}必须是文字`);
  if (value.length > limit) throw new Error(`${label}超过 ${limit} 字符，未截断或覆盖原数据`);
  return value;
}

function number(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label}必须是 ${min} 至 ${max} 范围内的有限数字`);
  }
  return value;
}

function color(value: unknown): NodeColor {
  if (value === undefined) return 'neutral';
  if (typeof value !== 'string' || (!COLORS.has(value as NodeColor) && !/^#[a-f0-9]{6}$/i.test(value))) throw new Error('卡片或连线颜色无效');
  return value as NodeColor;
}

/** Node IDs are data, not storage filenames: JSON Canvas permits arbitrary unique strings. */
function nodeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label}无效`);
  return value;
}

export function validateCanvasUrl(value: unknown): string {
  const url = text(value, '链接地址', 10_000);
  if (!/^https?:\/\//i.test(url) || /[\u0000-\u0020\u007f\\]/.test(url)) throw new Error('链接仅支持安全的 HTTP 或 HTTPS 地址');
  try {
    const parsed = new URL(url);
    if (!parsed.hostname || parsed.username || parsed.password || !['http:', 'https:'].includes(parsed.protocol)) throw new Error();
  } catch { throw new Error('链接地址无效'); }
  return url;
}

export function validateCanvasFile(value: unknown): string {
  const file = text(value, '文件路径', 10_000);
  if (/^https?:\/\//i.test(file)) return validateCanvasUrl(file);
  if (!file || /[\u0000-\u001f\u007f\\]/.test(file) || file.startsWith('//') || (file.startsWith('/') && !file.startsWith('/assets/')) || /^[^/]*:/.test(file)) throw new Error('文件仅支持安全相对路径、assets 路径或 HTTP/HTTPS 地址');
  let decoded = file;
  try {
    for (let depth = 0; depth < 5; depth++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch { throw new Error('文件路径编码无效'); }
  if (/[\u0000-\u001f\u007f\\]/.test(decoded) || decoded.startsWith('//') || (decoded.startsWith('/') && !decoded.startsWith('/assets/')) || /^[^/]*:/.test(decoded) || decoded.split(/[/?#]/).some(part => part === '.' || part === '..') || /%25|%2e|%2f|%5c/i.test(decoded)) throw new Error('文件路径不能越过资源目录');
  return file;
}

/** Kept for lossless interop only. An unresolved reference must never be loaded by the view. */
export function validateUnresolvedCanvasFile(value: unknown): string {
  const file = text(value, '待导入文件路径', 10_000);
  if (!file || /[\u0000-\u001f\u007f\\]/.test(file) || file.startsWith('/') || /^[^/]*:/.test(file)) throw new Error('待导入文件必须使用相对路径，不能包含磁盘路径或协议');
  return file;
}

/** External backgrounds are retained as references; only assets/HTTP(S) are renderable. */
export function validateCanvasBackground(value: unknown): string {
  if (typeof value === 'string' && (/^https?:\/\//i.test(value) || /^\/?assets\//.test(value))) return validateCanvasFile(value);
  return validateUnresolvedCanvasFile(value);
}

function subpath(value: unknown): string | undefined {
  if (value === undefined) return;
  const result = text(value, '文件子路径', 4_000);
  if (!result.startsWith('#') || /[\u0000-\u001f\u007f]/.test(result)) throw new Error('文件子路径必须以 # 开头');
  return result;
}

function extras(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return;
  const source = object(value, 'JSON Canvas 扩展');
  const visit = (input: unknown, depth: number): unknown => {
    if (depth > 32) throw new Error('JSON Canvas 扩展嵌套过深');
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map(item => visit(item, depth + 1));
    if (input && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype) return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, visit(value, depth + 1)]));
    throw new Error('JSON Canvas 扩展必须是可保存的 JSON 数据');
  };
  const result = visit(source, 0) as Record<string, unknown>;
  if (JSON.stringify(result).length > MAX_TOTAL_TEXT) throw new Error('JSON Canvas 扩展过大，未截断原数据');
  return result;
}

function side(value: unknown): NodeSide | undefined {
  if (value === undefined) return;
  if (!['top', 'right', 'bottom', 'left'].includes(String(value))) throw new Error('连线端口方向无效');
  return value as NodeSide;
}
function end(value: unknown): NodeEnd | undefined {
  if (value === undefined) return;
  if (value !== 'none' && value !== 'arrow') throw new Error('连线端点形状无效');
  return value;
}

/** Cryptographically random IDs are also safe as plugin-storage filename parts. */
export function newCanvasId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto?.getRandomValues !== 'function') throw new Error('当前环境不支持安全随机标识');
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createScene(title: string): CanvasScene {
  const name = text(title, '画布标题', MAX_TITLE).trim() || '未命名画布';
  return {
    version: 1, id: newCanvasId(), title: name, revision: null, updatedAt: Date.now(),
    viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [],
  };
}

/** Whitelist persisted fields; reject lossy/coercive repairs of substantive data. */
export function normalizeScene(value: unknown): CanvasScene {
  const scene = object(value, '画布');
  if (scene.version !== 1) throw new Error(`不支持的画布版本：${String(scene.version)}`);
  const id = safeId(scene.id, '画布 ID');
  const title = text(scene.title, '画布标题', MAX_TITLE, '未命名画布');
  const revision = scene.revision === null || scene.revision === undefined
    ? null : safeId(scene.revision, '画布修订标识');
  const updatedAt = number(scene.updatedAt, '画布更新时间', 0, 8_640_000_000_000_000);
  const sourceViewport = object(scene.viewport, '画布视口');
  const viewport = {
    x: number(sourceViewport.x, '视口横坐标', -MAX_COORDINATE, MAX_COORDINATE),
    y: number(sourceViewport.y, '视口纵坐标', -MAX_COORDINATE, MAX_COORDINATE),
    zoom: number(sourceViewport.zoom, '视口缩放', 0.01, 100),
  };
  if (!Array.isArray(scene.nodes) || !Array.isArray(scene.edges)) throw new Error('画布卡片或连线列表格式无效');
  if (scene.nodes.length > MAX_NODES) throw new Error(`画布超过 ${MAX_NODES} 张卡片，未截断原数据`);
  if (scene.edges.length > MAX_EDGES) throw new Error(`画布超过 ${MAX_EDGES} 条连线，未截断原数据`);
  let totalText = title.length;
  const nodeIds = new Set<string>();
  const nodes = scene.nodes.map((value: unknown): CanvasNode => {
    const node = object(value, '卡片');
    const currentNodeId = nodeId(node.id, '卡片 ID');
    if (nodeIds.has(currentNodeId)) throw new Error(`卡片 ID 重复：${currentNodeId}`);
    nodeIds.add(currentNodeId);
    const width = number(node.width, '卡片宽度', Number.MIN_VALUE, 100_000);
    const height = number(node.height, '卡片高度', Number.MIN_VALUE, 100_000);
    const base = {
      id: currentNodeId,
      x: number(node.x, '卡片横坐标', -MAX_COORDINATE, MAX_COORDINATE),
      y: number(node.y, '卡片纵坐标', -MAX_COORDINATE, MAX_COORDINATE),
      width, height, color: color(node.color),
      ...(node.groupId === undefined ? {} : {groupId: nodeId(node.groupId, '分组 ID')}),
      ...(node.jsonCanvas === undefined ? {} : {jsonCanvas: extras(node.jsonCanvas)}),
    };
    if (base.jsonCanvas) totalText += JSON.stringify(base.jsonCanvas).length;
    if (node.kind === 'doc') {
      if (typeof node.docId !== 'string' || !DOC_ID.test(node.docId)) throw new Error('文档卡片的思源文档 ID 无效');
      const nodeTitle = text(node.title, '文档卡片标题', MAX_TITLE);
      totalText += nodeTitle.length + (typeof node.subpath === 'string' ? node.subpath.length : 0);
      if (node.followedFrom !== undefined && (typeof node.followedFrom !== 'string' || !DOC_ID.test(node.followedFrom))) throw new Error('跟随来源文档 ID 无效');
      if (node.detached !== undefined && typeof node.detached !== 'boolean') throw new Error('子页跟随状态无效');
      return {...base, kind: 'doc', docId: node.docId, title: nodeTitle, ...(node.subpath === undefined ? {} : {subpath: subpath(node.subpath)}),
        ...(node.followedFrom === undefined ? {} : {followedFrom: node.followedFrom as string}),
        ...(node.detached === undefined ? {} : {detached: node.detached as boolean})};
    }
    if (node.kind === 'text') {
      const content = text(node.text, '文字卡片', MAX_TEXT);
      totalText += content.length;
      return {...base, kind: 'text', text: content};
    }
    if (node.kind === 'group') {
      if (node.collapsed !== undefined && typeof node.collapsed !== 'boolean') throw new Error('分组折叠状态必须是布尔值');
      const groupTitle = text(node.title, '分组标题', MAX_TITLE);
      totalText += groupTitle.length + (typeof node.background === 'string' ? node.background.length : 0);
      if (node.backgroundStyle !== undefined && !['cover', 'ratio', 'repeat'].includes(String(node.backgroundStyle))) throw new Error('分组背景显示方式无效');
      return {...base, kind: 'group', title: groupTitle,
        ...(node.collapsed === undefined ? {} : {collapsed: node.collapsed}),
        ...(node.background === undefined ? {} : {background: validateCanvasBackground(node.background)}),
        ...(node.backgroundStyle === undefined ? {} : {backgroundStyle: node.backgroundStyle as 'cover' | 'ratio' | 'repeat'}),
      };
    }
    if (node.kind === 'file') {
      if (node.unresolved !== undefined && typeof node.unresolved !== 'boolean') throw new Error('文件资源状态必须是布尔值');
      const file = node.unresolved ? validateUnresolvedCanvasFile(node.file) : validateCanvasFile(node.file);
      const name = node.name === undefined ? undefined : text(node.name, '文件名称', MAX_TITLE);
      if (node.mediaType !== undefined && !['image', 'pdf', 'audio', 'video', 'file'].includes(String(node.mediaType))) throw new Error('文件媒体类型无效');
      totalText += file.length + (name?.length || 0) + (typeof node.subpath === 'string' ? node.subpath.length : 0);
      return {...base, kind: 'file', file,
        ...(node.subpath === undefined ? {} : {subpath: subpath(node.subpath)}),
        ...(name === undefined ? {} : {name}),
        ...(node.mediaType === undefined ? {} : {mediaType: node.mediaType as 'image' | 'pdf' | 'audio' | 'video' | 'file'}),
        ...(node.unresolved === undefined ? {} : {unresolved: node.unresolved}),
      };
    }
    if (node.kind === 'link') {
      const url = validateCanvasUrl(node.url);
      const title = node.title === undefined ? undefined : text(node.title, '链接标题', MAX_TITLE);
      totalText += url.length + (title?.length || 0);
      return {...base, kind: 'link', url, ...(title === undefined ? {} : {title})};
    }
    throw new Error(`不支持的卡片类型：${String(node.kind)}`);
  });
  const edgeIds = new Set<string>();
  const edges = scene.edges.map((value: unknown): CanvasEdge => {
    const edge = object(value, '连线');
    const edgeId = nodeId(edge.id, '连线 ID');
    if (edgeIds.has(edgeId)) throw new Error(`连线 ID 重复：${edgeId}`);
    edgeIds.add(edgeId);
    const label = text(edge.label, '连线说明', 1_000);
    totalText += label.length;
    const extra = extras(edge.jsonCanvas);
    if (extra) totalText += JSON.stringify(extra).length;
    return {
      id: edgeId, from: nodeId(edge.from, '连线起点'), to: nodeId(edge.to, '连线终点'),
      label, color: color(edge.color),
      ...(edge.fromSide === undefined ? {} : {fromSide: side(edge.fromSide)}),
      ...(edge.toSide === undefined ? {} : {toSide: side(edge.toSide)}),
      ...(edge.fromEnd === undefined ? {} : {fromEnd: end(edge.fromEnd)}),
      ...(edge.toEnd === undefined ? {} : {toEnd: end(edge.toEnd)}),
      ...(extra === undefined ? {} : {jsonCanvas: extra}),
    };
  });
  let settings: CanvasSettings | undefined;
  if (scene.settings !== undefined) {
    const source = object(scene.settings, '画布设置'); settings = {};
    for (const [key, value] of Object.entries(source)) {
      if (!['snapToGrid', 'snapToObjects', 'readOnly'].includes(key)) throw new Error(`不支持的画布设置：${key}`);
      if (typeof value !== 'boolean') throw new Error(`画布设置 ${key} 必须是布尔值`);
      settings[key as keyof CanvasSettings] = value;
    }
  }
  const extra = extras(scene.jsonCanvas);
  if (scene.followParentId !== undefined && (typeof scene.followParentId !== 'string' || !DOC_ID.test(scene.followParentId))) throw new Error('自动跟随父文档 ID 无效');
  if (scene.followExcluded !== undefined && (!Array.isArray(scene.followExcluded) || scene.followExcluded.length > MAX_NODES || scene.followExcluded.some(item => typeof item !== 'string' || !DOC_ID.test(item)))) throw new Error('子页跟随排除列表无效');
  if (extra) totalText += JSON.stringify(extra).length;
  if (totalText > MAX_TOTAL_TEXT) throw new Error(`画布文字总量超过 ${MAX_TOTAL_TEXT} 字符，未截断原数据`);
  // Orphan endpoints and group references remain persisted. The view can skip
  // unavailable relations without destroying data that another edit may restore.
  return {version: 1, id, title, revision, updatedAt, viewport, nodes, edges,
    ...(scene.followParentId === undefined ? {} : {followParentId: scene.followParentId as string}),
    ...(scene.followExcluded === undefined ? {} : {followExcluded: [...new Set(scene.followExcluded as string[])]}),
    ...(settings === undefined ? {} : {settings}), ...(extra === undefined ? {} : {jsonCanvas: extra}),
  };
}

/** Accept explicit document payloads/links, never arbitrary IDs inside tree HTML. */
export function extractDropIds(text: string): string[] {
  if (typeof text !== 'string' || text.length > 2_000_000) return [];
  const result = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && DOC_ID.test(value)) result.add(value);
    if (result.size > MAX_NODES) throw new Error(`一次最多拖入 ${MAX_NODES} 个文档`);
  };
  const readText = (value: string) => {
    const source = value.trim();
    if (!source || source.startsWith('<')) return;
    let match: RegExpExecArray | null;
    let hasLink = false;
    const links = /\bsiyuan:\/\/blocks\/(\d{14}-[a-z0-9]{7})(?=[/?#\s)\]"'<>]|$)/g;
    while ((match = links.exec(source))) { hasLink = true; add(match[1]); }
    if (!hasLink && source.split(/[\s,;]+/).every(part => DOC_ID.test(part))) {
      source.split(/[\s,;]+/).forEach(add);
    }
  };
  const readPayload = (value: unknown, depth = 0): void => {
    if (depth > 8) return;
    if (typeof value === 'string') { readText(value); return; }
    if (Array.isArray(value)) { value.forEach(item => readPayload(item, depth + 1)); return; }
    if (!value || typeof value !== 'object') return;
    const payload = value as Record<string, unknown>;
    if (payload.type === 'navigation-root' || payload.type === 'notebook' || payload.type === 'notebooks') return;
    if (Array.isArray(payload.ids)) payload.ids.forEach(add);
    add(payload.rootId);
    add(payload.rootID);
    if (payload.type === 'doc' || payload.type === 'document' || payload.type === 'navigation-file') {
      add(payload.id);
      if (Array.isArray(payload.data)) payload.data.forEach(item => readPayload(item, depth + 1));
    }
  };
  const source = text.trim();
  if (source.startsWith('{') || source.startsWith('[') || source.startsWith('"')) {
    let payload: unknown;
    try { payload = JSON.parse(source); } catch { readText(source); return [...result]; }
    readPayload(payload);
  } else readText(source);
  return [...result];
}
