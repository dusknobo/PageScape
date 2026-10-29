import { createScene, normalizeScene, validateCanvasFile, validateUnresolvedCanvasFile, validateCanvasBackground } from './model';
import type { CanvasEdge, CanvasNode, CanvasScene, NodeColor } from './types';

export const JSON_CANVAS_EXTENSION = 'x-siyuan-child-cards';
const EXT = JSON_CANVAS_EXTENSION;
const DOC = /^siyuan:\/\/blocks\/(\d{14}-[a-z0-9]{7})$/;
const PRESETS: Record<string, NodeColor> = { '1': 'red', '2': 'orange', '3': 'yellow', '4': 'green', '5': 'cyan', '6': 'purple' };
const TO_PRESET: Partial<Record<NodeColor, string>> = { red: '1', orange: '2', yellow: '3', green: '4', cyan: '5', purple: '6' };
const STANDARD_NODE = ['id', 'type', 'x', 'y', 'width', 'height', 'color'];

export interface JsonCanvasNode extends Record<string, unknown> {
  id: string; type: 'text' | 'file' | 'link' | 'group';
  x: number; y: number; width: number; height: number;
  color?: string; text?: string; file?: string; subpath?: string; url?: string;
  label?: string; background?: string; backgroundStyle?: 'cover' | 'ratio' | 'repeat';
}
export interface JsonCanvasEdge extends Record<string, unknown> {
  id: string; fromNode: string; toNode: string;
  fromSide?: 'top' | 'right' | 'bottom' | 'left'; toSide?: 'top' | 'right' | 'bottom' | 'left';
  fromEnd?: 'none' | 'arrow'; toEnd?: 'none' | 'arrow'; color?: string; label?: string;
}
export interface JsonCanvasDocument extends Record<string, unknown> { nodes: JsonCanvasNode[]; edges: JsonCanvasEdge[] }
export interface JsonCanvasImport { scene: CanvasScene; warnings: string[] }
export interface JsonCanvasImportOptions { title?: string; id?: string }

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是 JSON 对象`);
  return value as Record<string, unknown>;
}
function optionalExtension(source: Record<string, unknown>): Record<string, unknown> {
  if (source[EXT] === undefined) return {};
  const result = record(source[EXT], '思源画布扩展');
  if (result.version !== undefined && result.version !== 1) throw new Error('不支持此思源 JSON Canvas 扩展版本');
  return result;
}
function extraFields(source: Record<string, unknown>, known: string[], extensionKeys: string[]): Record<string, unknown> | undefined {
  const entries = Object.entries(source).filter(([key]) => key !== EXT && !known.includes(key));
  const unknownExtension = Object.fromEntries(Object.entries(optionalExtension(source)).filter(([key]) => !extensionKeys.includes(key)));
  if (Object.keys(unknownExtension).length) entries.push([EXT, unknownExtension]);
  return entries.length ? Object.fromEntries(entries) : undefined;
}
function metadata(source: Record<string, unknown> | undefined, values: Record<string, unknown>): Record<string, unknown> {
  const previous = source?.[EXT];
  return { ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}), ...values };
}
function requireNonConflictingExtras(source: Record<string, unknown> | undefined, reserved: string[]): void {
  if (source && reserved.some(key => Object.hasOwn(source, key))) throw new Error('JSON Canvas 扩展字段与标准字段冲突，未导出或丢弃原数据');
}
function fromColor(value: unknown, extension: Record<string, unknown>): NodeColor {
  let result: NodeColor;
  if (value === undefined) result = 'neutral';
  else if (typeof value === 'string' && PRESETS[value]) result = PRESETS[value];
  else if (typeof value === 'string' && /^#[a-f0-9]{6}$/i.test(value)) result = value as NodeColor;
  else throw new Error('JSON Canvas 颜色必须为 1–6 或 #RRGGBB');
  // JSON Canvas has six presets; our additional blue preset uses a portable hex value.
  if (extension.color === 'blue' && value === '#5489CC') result = 'blue';
  return result;
}
function toColor(value: NodeColor): string | undefined {
  return value === 'neutral' ? undefined : value === 'blue' ? '#5489CC' : TO_PRESET[value] || value;
}
function fileReference(value: unknown): { file: string; unresolved?: true } {
  if (typeof value !== 'string') throw new Error('JSON Canvas 文件路径必须是文字');
  if (/^https?:\/\//i.test(value) || /^\/?assets\//.test(value)) return { file: validateCanvasFile(value) };
  return { file: validateUnresolvedCanvasFile(value), unresolved: true };
}
function text(value: unknown, label: string, fallback = ''): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error(`${label}必须是文字`);
  return value;
}

/** Import data only. No external file is read and the destination board is chosen by the caller. */
export function importJsonCanvas(value: string | unknown, options: JsonCanvasImportOptions = {}): JsonCanvasImport {
  let input: unknown = value;
  if (typeof value === 'string') {
    if (value.length > 10_000_000) throw new Error('JSON Canvas 文件过大，未截断导入');
    try { input = JSON.parse(value); } catch (cause) { throw new Error('JSON Canvas 文件不是有效 JSON', { cause }); }
  }
  const source = record(input, 'JSON Canvas');
  if (source.nodes === undefined && source.edges === undefined && source[EXT] === undefined && Object.keys(source).length) throw new Error('未识别为 JSON Canvas 1.0 文件，未创建空画布');
  if ((source.nodes !== undefined && !Array.isArray(source.nodes)) || (source.edges !== undefined && !Array.isArray(source.edges))) throw new Error('JSON Canvas nodes 和 edges 必须是数组');
  const rawNodes = (source.nodes || []) as unknown[]; const rawEdges = (source.edges || []) as unknown[];
  if (rawNodes.length > 2_000 || rawEdges.length > 5_000) throw new Error('JSON Canvas 超过 2000 节点或 5000 连线，未截断导入');
  const extension = optionalExtension(source);
  if (extension.title !== undefined && (typeof extension.title !== 'string' || extension.title.length > 300)) throw new Error('思源扩展画布标题无效或超过 300 个字符');
  const scene = createScene(options.title ?? text(extension.title, '画布标题', '导入画布'));
  if (options.id !== undefined) scene.id = options.id;
  if (extension.viewport !== undefined) scene.viewport = extension.viewport as CanvasScene['viewport'];
  if (extension.settings !== undefined) scene.settings = extension.settings as CanvasScene['settings'];
  if (extension.followParentId !== undefined) scene.followParentId = extension.followParentId as string;
  if (extension.followExcluded !== undefined) scene.followExcluded = extension.followExcluded as string[];
  scene.jsonCanvas = extraFields(source, ['nodes', 'edges'], ['version', 'title', 'viewport', 'settings', 'followParentId', 'followExcluded']);
  const warnings = new Set<string>();
  const explicitMembership = new Set<string>();
  scene.nodes = rawNodes.map((value): CanvasNode => {
    const item = record(value, 'JSON Canvas 节点'); const ext = optionalExtension(item);
    if (!['text', 'file', 'link', 'group'].includes(String(item.type))) throw new Error(`不支持的 JSON Canvas 节点类型：${String(item.type)}`);
    if (ext.kind !== undefined && ext.kind !== item.type && !(item.type === 'file' && ext.kind === 'doc')) throw new Error('思源节点类型扩展与 JSON Canvas 节点类型不一致');
    const knownExtension = ['version', 'kind', 'groupId', ...(ext.color === 'blue' && item.color === '#5489CC' ? ['color'] : [])];
    if (!['id', 'x', 'y', 'width', 'height'].every(key => item[key] !== undefined)) throw new Error('JSON Canvas 节点缺少 ID 或几何信息');
    const base = { id: item.id as string, x: item.x as number, y: item.y as number, width: item.width as number, height: item.height as number, color: fromColor(item.color, ext), ...(ext.groupId === undefined ? {} : { groupId: ext.groupId as string }) };
    if (ext.kind !== undefined || ext.groupId !== undefined) explicitMembership.add(base.id);
    const known = [...STANDARD_NODE];
    let node: CanvasNode;
    if (item.type === 'text') {
      if (typeof item.text !== 'string') throw new Error('JSON Canvas 文字节点缺少 text');
      known.push('text'); node = { ...base, kind: 'text', text: item.text };
    } else if (item.type === 'file') {
      known.push('file', 'subpath');
      const docId = typeof item.file === 'string' ? DOC.exec(item.file)?.[1] : undefined;
      if (ext.kind === 'doc' && (!docId || (ext.docId !== undefined && ext.docId !== docId))) throw new Error('思源文档引用与 JSON Canvas 文件引用不一致，未替换原引用');
      if (docId) {
        knownExtension.push('docId', 'title', 'followedFrom', 'detached');
        node = { ...base, kind: 'doc', docId, title: text(ext.title, '文档标题', docId), ...(item.subpath === undefined ? {} : { subpath: item.subpath as string }),
          ...(ext.followedFrom === undefined ? {} : { followedFrom: ext.followedFrom as string }), ...(ext.detached === undefined ? {} : { detached: ext.detached as boolean }) };
      } else {
        knownExtension.push('name', 'mediaType', 'unresolved');
        if (ext.unresolved !== undefined && typeof ext.unresolved !== 'boolean') throw new Error('文件资源状态扩展必须是布尔值');
        const reference = fileReference(item.file);
        node = { ...base, kind: 'file', ...reference,
          ...(item.subpath === undefined ? {} : { subpath: item.subpath as string }),
          ...(ext.name === undefined ? {} : { name: ext.name as string }),
          ...(ext.mediaType === undefined ? {} : { mediaType: ext.mediaType as 'image' | 'pdf' | 'audio' | 'video' | 'file' }),
          ...(reference.unresolved ? {} : ext.unresolved === undefined ? {} : { unresolved: ext.unresolved as boolean }),
        };
        if (reference.unresolved) warnings.add('画布包含外部相对文件引用，路径已保留；资源需要单独导入，当前显示待导入占位，不读取原路径。');
      }
    } else if (item.type === 'link') {
      knownExtension.push('title');
      known.push('url'); node = { ...base, kind: 'link', url: item.url as string, ...(ext.title === undefined ? {} : { title: ext.title as string }) };
    } else {
      knownExtension.push('collapsed');
      known.push('label', 'background', 'backgroundStyle');
      node = { ...base, kind: 'group', title: text(item.label, '分组名称'),
        ...(ext.collapsed === undefined ? {} : { collapsed: ext.collapsed as boolean }),
        ...(item.background === undefined ? {} : { background: validateCanvasBackground(item.background) }),
        ...(item.backgroundStyle === undefined ? {} : { backgroundStyle: item.backgroundStyle as 'cover' | 'ratio' | 'repeat' }),
      };
      if (item.background && !/^https?:\/\/|^\/?assets\//i.test(String(item.background))) warnings.add('分组背景引用已保留；外部背景资源需要单独导入。');
    }
    const extra = extraFields(item, known, knownExtension); if (extra) node.jsonCanvas = extra;
    return node;
  });
  // Standard groups define visual containment. Infer the smallest containing group
  // only when no explicit SiYuan membership was provided, preserving input z-order.
  const groups = scene.nodes.filter(item => item.kind === 'group');
  for (const item of scene.nodes) {
    if (item.groupId !== undefined || explicitMembership.has(item.id)) continue;
    const parent = groups.filter(group => group.id !== item.id && group.x <= item.x && group.y <= item.y && group.x + group.width >= item.x + item.width && group.y + group.height >= item.y + item.height && group.width * group.height > item.width * item.height)
      .sort((a, b) => a.width * a.height - b.width * b.height)[0];
    if (parent) item.groupId = parent.id;
  }
  scene.edges = rawEdges.map((value): CanvasEdge => {
    const item = record(value, 'JSON Canvas 连线'); const extension = optionalExtension(item);
    const extra = extraFields(item, ['id', 'fromNode', 'toNode', 'fromSide', 'toSide', 'fromEnd', 'toEnd', 'color', 'label'], ['version', ...(extension.color === 'blue' && item.color === '#5489CC' ? ['color'] : [])]);
    return { id: item.id as string, from: item.fromNode as string, to: item.toNode as string, label: text(item.label, '连线文字'), color: fromColor(item.color, optionalExtension(item)),
      ...(item.fromSide === undefined ? {} : { fromSide: item.fromSide as CanvasEdge['fromSide'] }),
      ...(item.toSide === undefined ? {} : { toSide: item.toSide as CanvasEdge['toSide'] }),
      ...(item.fromEnd === undefined ? {} : { fromEnd: item.fromEnd as CanvasEdge['fromEnd'] }),
      ...(item.toEnd === undefined ? {} : { toEnd: item.toEnd as CanvasEdge['toEnd'] }),
      ...(extra ? { jsonCanvas: extra } : {}),
    };
  });
  const normalized = normalizeScene(scene);
  const ids = new Set(normalized.nodes.map(item => item.id));
  if (normalized.edges.some(edge => !ids.has(edge.from) || !ids.has(edge.to))) warnings.add('部分连线端点不存在，引用已保留，补回对应节点后可恢复显示。');
  if (!normalized.nodes.length) warnings.add('这是一个空画布，未导入任何节点。');
  return { scene: normalized, warnings: [...warnings] };
}

/** Emit JSON Canvas 1.0 data; node order is deliberately kept as the z-order. */
export function exportJsonCanvas(value: CanvasScene): JsonCanvasDocument {
  const scene = normalizeScene(value);
  requireNonConflictingExtras(scene.jsonCanvas, ['nodes', 'edges']);
  const nodes: JsonCanvasNode[] = scene.nodes.map(node => {
    const fields = node.kind === 'text' ? ['text'] : node.kind === 'file' || node.kind === 'doc' ? ['file', 'subpath'] : node.kind === 'link' ? ['url'] : ['label', 'background', 'backgroundStyle'];
    requireNonConflictingExtras(node.jsonCanvas, [...STANDARD_NODE, ...fields]);
    const color = toColor(node.color);
    const base: JsonCanvasNode = { ...node.jsonCanvas, id: node.id, type: node.kind === 'doc' ? 'file' : node.kind,
      x: Math.round(node.x), y: Math.round(node.y), width: Math.max(1, Math.round(node.width)), height: Math.max(1, Math.round(node.height)),
      ...(color === undefined ? {} : { color }),
    };
    const ext: Record<string, unknown> = { version: 1, kind: node.kind, ...(node.groupId === undefined ? {} : { groupId: node.groupId }), ...(node.color === 'blue' ? { color: 'blue' } : {}) };
    if (node.kind === 'doc') { base.file = `siyuan://blocks/${node.docId}`; ext.docId = node.docId; ext.title = node.title; if (node.subpath !== undefined) base.subpath = node.subpath; if (node.followedFrom !== undefined) ext.followedFrom = node.followedFrom; if (node.detached !== undefined) ext.detached = node.detached; }
    else if (node.kind === 'text') base.text = node.text;
    else if (node.kind === 'file') {
      base.file = node.file; if (node.subpath !== undefined) base.subpath = node.subpath;
      if (node.name !== undefined) ext.name = node.name;
      if (node.mediaType !== undefined) ext.mediaType = node.mediaType;
      if (node.unresolved !== undefined) ext.unresolved = node.unresolved;
    } else if (node.kind === 'link') { base.url = node.url; if (node.title !== undefined) ext.title = node.title; }
    else {
      base.label = node.title; if (node.background !== undefined) base.background = node.background;
      if (node.collapsed !== undefined) ext.collapsed = node.collapsed;
      if (node.backgroundStyle !== undefined) base.backgroundStyle = node.backgroundStyle;
    }
    base[EXT] = metadata(node.jsonCanvas, ext); return base;
  });
  const edges: JsonCanvasEdge[] = scene.edges.map(edge => {
    requireNonConflictingExtras(edge.jsonCanvas, ['id', 'fromNode', 'toNode', 'fromSide', 'toSide', 'fromEnd', 'toEnd', 'color', 'label']);
    return { ...edge.jsonCanvas, id: edge.id, fromNode: edge.from, toNode: edge.to,
    ...(edge.label ? { label: edge.label } : {}), ...(toColor(edge.color) === undefined ? {} : { color: toColor(edge.color) }),
    ...(edge.fromSide === undefined ? {} : { fromSide: edge.fromSide }), ...(edge.toSide === undefined ? {} : { toSide: edge.toSide }),
    ...(edge.fromEnd === undefined ? {} : { fromEnd: edge.fromEnd }), ...(edge.toEnd === undefined ? {} : { toEnd: edge.toEnd }),
    [EXT]: metadata(edge.jsonCanvas, { version: 1, ...(edge.color === 'blue' ? { color: 'blue' } : {}) }),
  }; });
  return { ...scene.jsonCanvas, nodes, edges,
    [EXT]: metadata(scene.jsonCanvas, { version: 1, title: scene.title, viewport: scene.viewport, ...(scene.settings === undefined ? {} : { settings: scene.settings }),
      ...(scene.followParentId === undefined ? {} : { followParentId: scene.followParentId }), ...(scene.followExcluded === undefined ? {} : { followExcluded: scene.followExcluded }) }),
  };
}
