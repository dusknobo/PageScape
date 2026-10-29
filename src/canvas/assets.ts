import type { CanvasScene } from './types';

/** SiYuan's native resource collector reads each custom-data-assets* IAL value. */
export const CANVAS_ASSET_ATTR_PREFIX = 'custom-data-assets-scc-';

function localAsset(value: string): string | undefined {
  const path = value.trim().split(/[?#]/, 1)[0].replace(/^\/assets\//, 'assets/');
  if (!path.startsWith('assets/') || path.length <= 7 || path.endsWith('/')) return;
  let decoded = path;
  for (let round = 0; round < 6; round++) {
    if (/[\\:\u0000-\u001f\u007f]/.test(decoded) || decoded.split('/').some(part => !part || part === '.' || part === '..')) return;
    if (!/%[0-9a-f]{2}/i.test(decoded)) return path;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return path;
      decoded = next;
    } catch { return; }
  }
  // Deeply encoded separators must never bypass the local-assets boundary.
}

function entities(value: string): string {
  const names: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (match, key: string) => {
    if (key[0] !== '#') return names[key.toLowerCase()] || match;
    const number = key[1]?.toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : match;
  });
}

function markdownDestination(value: string): string {
  let result = value.trim();
  if (result.startsWith('<')) {
    const close = result.indexOf('>');
    if (close < 0) return '';
    result = result.slice(1, close);
  } else {
    result = result.replace(/\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\([^()]*\))\s*$/, '');
  }
  return entities(result.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1'));
}

/** Collect complete destinations, never an assets/ substring inside a remote URL. */
function markdownAssets(text: string, add: (value: string) => void): void {
  let fence = ''; let fenceLength = 0;
  const visible = text.split(/\r?\n/).map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence && marker.length >= fenceLength))) {
      if (fence) fence = ''; else { fence = marker[0]; fenceLength = marker.length; }
      return '';
    }
    return fence ? '' : line;
  }).join('\n').replace(/(`+)[\s\S]*?\1(?!`)/g, '');
  for (let index = 0; index < visible.length - 1; index++) {
    if (visible[index] !== ']' || visible[index + 1] !== '(') continue;
    const start = index + 2; let depth = 1; let end = start;
    for (; end < visible.length; end++) {
      if (visible[end] === '\\') { end++; continue; }
      if (visible[end] === '(') depth++;
      if (visible[end] === ')' && --depth === 0) break;
    }
    if (depth === 0) { add(markdownDestination(visible.slice(start, end))); index = end; }
  }
  for (const match of visible.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(.+)$/gm)) add(markdownDestination(match[1]));
  for (const tag of visible.matchAll(/<[a-z][^>]*>/gi)) {
    for (const attr of tag[0].matchAll(/\b(?:src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) add(entities(attr[1] ?? attr[2] ?? attr[3]));
  }
}

export function collectCanvasAssetPaths(scene: CanvasScene): string[] {
  const paths = new Set<string>();
  const add = (value: string) => { const asset = localAsset(value); if (asset) paths.add(asset); };
  for (const node of scene.nodes) {
    if (node.kind === 'file' && !node.unresolved) add(node.file);
    else if (node.kind === 'group' && node.background) add(node.background);
    else if (node.kind === 'text') markdownAssets(node.text, add);
  }
  return [...paths].sort();
}

export function withCanvasAssetAttributes(scene: CanvasScene, existing: Record<string, string> = {}): Record<string, string> {
  const attrs = Object.fromEntries(Object.entries(existing).filter(([name]) => !name.startsWith(CANVAS_ASSET_ATTR_PREFIX)));
  collectCanvasAssetPaths(scene).forEach((path, index) => { attrs[CANVAS_ASSET_ATTR_PREFIX + index] = path; });
  return attrs;
}

export function verifyCanvasAssetAttributes(scene: CanvasScene, actual: Record<string, string>): void {
  const expected = withCanvasAssetAttributes(scene);
  const names = Object.keys(actual).filter(name => name.startsWith(CANVAS_ASSET_ATTR_PREFIX));
  if (names.length !== Object.keys(expected).length || names.some(name => actual[name] !== expected[name])) {
    throw new Error('画布附件引用登记核对失败，请重试保存；未清理任何附件');
  }
}
