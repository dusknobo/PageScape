import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScene, normalizeScene, validateCanvasFile, validateCanvasUrl } from '../src/canvas/model';
import { exportJsonCanvas, importJsonCanvas, JSON_CANVAS_EXTENSION as EXT } from '../src/canvas/json-canvas';
import type { CanvasScene } from '../src/canvas/types';
import { safeCanvasUrl } from '../src/canvas/view-content';

const DOC = '20261017120000-abcdefg';
const geometry = { x: 10, y: -20, width: 300, height: 200 };
const textNode = (id = 'UpperCASE-ID') => ({ id, type: 'text', ...geometry, text: '**Markdown**' });

function richScene(): CanvasScene {
  const scene = createScene('互通画布');
  scene.viewport = { x: 41, y: -23, zoom: 1.25 };
  scene.settings = { snapToGrid: true, snapToObjects: false, readOnly: false };
  scene.nodes = [
    { id: 'Group A', kind: 'group', title: '分组', x: 0, y: 0, width: 900, height: 700, color: 'yellow', background: 'assets/background.png', backgroundStyle: 'ratio' },
    { id: 'DOC-A', kind: 'doc', docId: DOC, title: '原始文档', ...geometry, color: 'blue', subpath: '#^20261017120100-bcdefgh', groupId: 'Group A' },
    { id: 'text-A', kind: 'text', text: '保留便签', ...geometry, color: '#12AbEF' },
    { id: 'File A', kind: 'file', file: 'assets/chart.png', name: '图表', mediaType: 'image', subpath: '#section', ...geometry, color: 'red' },
    { id: 'Link A', kind: 'link', url: 'https://example.com/path?q=1#part', title: '网页', ...geometry, color: 'cyan' },
  ];
  scene.edges = [
    { id: 'Edge A', from: 'DOC-A', to: 'File A', label: '双箭头', color: 'purple', fromSide: 'top', toSide: 'left', fromEnd: 'arrow', toEnd: 'arrow' },
    { id: 'Edge B', from: 'text-A', to: 'Link A', label: '', color: 'neutral', fromSide: 'right', toSide: 'bottom', fromEnd: 'none', toEnd: 'none' },
  ];
  return scene;
}

test('JSON Canvas round-trip preserves native docs, all node kinds, settings, colors, subpaths and edge direction', () => {
  const original = richScene();
  const exported = exportJsonCanvas(original);
  assert.equal(exported.nodes[1].type, 'file');
  assert.equal(exported.nodes[1].file, `siyuan://blocks/${DOC}`);
  assert.equal(exported.nodes[1].color, '#5489CC');
  const { scene, warnings } = importJsonCanvas(JSON.stringify(exported), { id: original.id });
  assert.deepEqual(scene.nodes, original.nodes);
  assert.deepEqual(scene.edges, original.edges);
  assert.deepEqual(scene.settings, original.settings);
  assert.deepEqual(scene.viewport, original.viewport);
  assert.equal(scene.title, original.title);
  assert.deepEqual(warnings, []);
});

test('external relative resources remain unresolved and export their exact reference without reading paths', () => {
  for (const file of ['images/plot.png', '../attachments/plot.png', 'notes/file.md', '../../outside.png']) {
    const { scene, warnings } = importJsonCanvas({ nodes: [{ id: 'resource', type: 'file', ...geometry, file, subpath: '#Heading' }] });
    assert.equal(scene.nodes[0].kind, 'file');
    assert.equal(scene.nodes[0].kind === 'file' && scene.nodes[0].file, file);
    assert.equal(scene.nodes[0].kind === 'file' && scene.nodes[0].unresolved, true);
    assert.match(warnings.join('\n'), /资源需要单独导入/);
    assert.equal(exportJsonCanvas(scene).nodes[0].file, file);
    assert.equal(exportJsonCanvas(scene).nodes[0].subpath, '#Heading');
  }
});

test('external group backgrounds retain exact relative paths and styles without becoming loadable URLs', () => {
  for (const background of ['../images/bg.png', 'images/bg.png', '../../old-vault/background.webp']) {
    for (const backgroundStyle of ['cover', 'ratio', 'repeat']) {
      const source = { nodes: [{ id: 'Group Background', type: 'group', ...geometry, label: '背景分组', background, backgroundStyle }] };
      const { scene, warnings } = importJsonCanvas(source);
      assert.equal(scene.nodes[0].kind, 'group');
      assert.equal(scene.nodes[0].kind === 'group' && scene.nodes[0].background, background);
      assert.equal(safeCanvasUrl(background), undefined, 'external paths must remain data, never automatic src/backgroundImage URLs');
      assert.match(warnings.join('\n'), /外部背景资源需要单独导入/);
      const exported = exportJsonCanvas(scene);
      assert.equal(exported.nodes[0].background, background);
      assert.equal(exported.nodes[0].backgroundStyle, backgroundStyle);
      const imported = importJsonCanvas(exported).scene;
      assert.deepEqual(imported.nodes, scene.nodes);
    }
  }
  assert.equal(safeCanvasUrl('assets/background.png'), '/assets/background.png');
  assert.equal(safeCanvasUrl('https://example.com/background.png'), 'https://example.com/background.png');
  for (const background of ['javascript:alert(1)', '/etc/secret.png', 'C:/private.png', 'assets/%2e%2e/private.png']) {
    assert.throws(() => importJsonCanvas({ nodes: [{ id: 'bad-group', type: 'group', ...geometry, background }] }), undefined, background);
  }
});

test('valid standard fields and foreign fields from other node types do not collide during re-export', () => {
  const source = { nodes: [
    { ...textNode('Text'), file: 'foreign-file-field', label: 'foreign-label' },
    { id: 'File', type: 'file', ...geometry, file: 'assets/plot.png', subpath: '#Section', text: 'foreign-text' },
    { id: 'Web', type: 'link', ...geometry, url: 'https://example.com/', label: 'foreign-label' },
    { id: 'Group', type: 'group', ...geometry, label: 'Standard label', background: '../images/bg.png', backgroundStyle: 'ratio', text: 'foreign-text' },
  ], edges: [{ id: 'Edge', fromNode: 'Text', toNode: 'File', fromSide: 'left', toSide: 'top', fromEnd: 'none', toEnd: 'arrow', color: '#AbCdEf', label: 'Standard edge', foreign: true }] };
  const scene = importJsonCanvas(source).scene;
  const output = exportJsonCanvas(scene);
  assert.equal(output.nodes[0].file, source.nodes[0].file);
  assert.equal(output.nodes[0].label, source.nodes[0].label);
  assert.equal(output.nodes[1].text, source.nodes[1].text);
  assert.equal(output.nodes[2].label, source.nodes[2].label);
  assert.equal(output.nodes[3].text, source.nodes[3].text);
  assert.equal(output.nodes[3].background, '../images/bg.png');
  assert.equal(output.edges[0].foreign, true);
  assert.deepEqual(importJsonCanvas(output).scene.nodes, scene.nodes);
  assert.deepEqual(importJsonCanvas(output).scene.edges, scene.edges);
});

test('unsafe executable schemes, absolute OS paths and encoded asset traversal fail explicitly', () => {
  for (const file of ['javascript:alert(1)', 'data:image/svg+xml,x', 'file:///etc/passwd', '/etc/passwd', 'C:/Users/private.txt', '\\\\server\\file', 'assets/%2e%2e/private', 'assets/%252e%252e/private', 'assets/%5c..%5cprivate']) {
    assert.throws(() => importJsonCanvas({ nodes: [{ id: 'bad', type: 'file', ...geometry, file }] }), undefined, file);
  }
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///private', 'https://user:secret@example.com/', 'https://example.com/\nnext']) {
    assert.throws(() => importJsonCanvas({ nodes: [{ id: 'bad', type: 'link', ...geometry, url }] }), undefined, url);
  }
  assert.equal(validateCanvasUrl('https://example.com/image.png'), 'https://example.com/image.png');
  assert.equal(validateCanvasFile('/assets/local.png'), '/assets/local.png');
  assert.equal(safeCanvasUrl('assets/my picture.png'), '/assets/my picture.png');
  assert.equal(safeCanvasUrl('assets/my%20picture.png'), '/assets/my%20picture.png');
  assert.equal(safeCanvasUrl('assets/bad\nimage.png'), undefined);
  for (const path of ['%2fetc/passwd', '%6aavascript%3aalert(1)', '%252fetc/passwd']) assert.throws(() => validateCanvasFile(path), /资源目录/);
});

test('manually conflicting interop extras fail export without replacing standard fields', () => {
  const original = richScene();
  const rootConflict = structuredClone(original); rootConflict.jsonCanvas = { nodes: [] };
  assert.throws(() => exportJsonCanvas(rootConflict), /字段冲突/);
  const nodeConflict = structuredClone(original); nodeConflict.nodes[0].jsonCanvas = { color: '1' };
  assert.throws(() => exportJsonCanvas(nodeConflict), /字段冲突/);
  const edgeConflict = structuredClone(original); edgeConflict.edges[0].jsonCanvas = { label: 'replace' };
  assert.throws(() => exportJsonCanvas(edgeConflict), /字段冲突/);
});

test('unknown root, node, edge and namespaced extension data survive round-trip without prototype pollution', () => {
  const input = JSON.parse(`{"nodes":[{"id":"UPPER","type":"text","x":0,"y":0,"width":200,"height":100,"text":"hello","customNode":{"keep":[1,true]},"__proto__":{"polluted":"node"},"${EXT}":{"vendorFuture":{"keep":"node"}}}],"edges":[{"id":"E","fromNode":"UPPER","toNode":"UPPER","customEdge":42,"${EXT}":{"vendorFuture":["edge"]}}],"customRoot":{"keep":true},"__proto__":{"polluted":"root"},"${EXT}":{"vendorFuture":{"keep":"root"}}}`);
  const scene = importJsonCanvas(input).scene;
  const output = exportJsonCanvas(scene);
  assert.deepEqual(output.customRoot, input.customRoot);
  assert.deepEqual(output.nodes[0].customNode, input.nodes[0].customNode);
  assert.equal(output.edges[0].customEdge, 42);
  assert.deepEqual((output[EXT] as Record<string, unknown>).vendorFuture, input[EXT].vendorFuture);
  assert.deepEqual((output.nodes[0][EXT] as Record<string, unknown>).vendorFuture, input.nodes[0][EXT].vendorFuture);
  assert.deepEqual((output.edges[0][EXT] as Record<string, unknown>).vendorFuture, input.edges[0][EXT].vendorFuture);
  assert.equal(Object.hasOwn(output, '__proto__'), true);
  assert.deepEqual(output.__proto__, { polluted: 'root' });
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(({} as Record<string, unknown>).keep, undefined);
});

test('extension text and nesting remain inside shared scene budgets', () => {
  let nested: unknown = 'leaf';
  for (let i = 0; i < 40; i++) nested = { nested };
  assert.throws(() => importJsonCanvas({ nodes: [textNode()], extra: nested }), /嵌套过深/);
  assert.throws(() => importJsonCanvas({ nodes: [textNode()], extra: 'x'.repeat(2_000_001) }), /过大|文字总量/);
  assert.throws(() => importJsonCanvas({ nodes: [{ ...textNode('a'), extra: 'x'.repeat(1_100_000) }, { ...textNode('b'), extra: 'y'.repeat(1_100_000) }] }), /文字总量/);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.throws(() => importJsonCanvas({ nodes: [textNode()], extra: cyclic }), /嵌套过深/);
  assert.throws(() => importJsonCanvas({ nodes: [textNode()], extra: { invalid: Infinity } }), /JSON 数据/);
});

test('uppercase and Unicode node IDs remain exact while duplicate identifiers fail without remapping loss', () => {
  const nodes = [textNode('ABCDEF-123'), textNode('节点 A')];
  const scene = importJsonCanvas({ nodes, edges: [{ id: 'EDGE', fromNode: 'ABCDEF-123', toNode: '节点 A' }] }).scene;
  assert.deepEqual(scene.nodes.map(node => node.id), ['ABCDEF-123', '节点 A']);
  assert.deepEqual(exportJsonCanvas(scene).nodes.map(node => node.id), ['ABCDEF-123', '节点 A']);
  assert.throws(() => importJsonCanvas({ nodes: [nodes[0], nodes[0]] }), /重复/);
  assert.throws(() => importJsonCanvas({ nodes, edges: [{ id: 'e', fromNode: 'ABCDEF-123', toNode: '节点 A' }, { id: 'e', fromNode: '节点 A', toNode: 'ABCDEF-123' }] }), /重复/);
});

test('node ordering is z-order and geometric group inference does not regroup an explicitly ungrouped native node', () => {
  const original = richScene();
  const imported = importJsonCanvas(exportJsonCanvas(original)).scene;
  assert.deepEqual(imported.nodes.map(node => node.id), original.nodes.map(node => node.id));
  assert.equal(imported.nodes[2].groupId, undefined);
  const standard = importJsonCanvas({ nodes: [
    { id: 'group', type: 'group', x: 0, y: 0, width: 1000, height: 1000, label: '标准分组' },
    { ...textNode('child'), x: 30, y: 30 },
  ] }).scene;
  assert.equal(standard.nodes[1].groupId, 'group');
  assert.deepEqual(standard.nodes.map(node => node.id), ['group', 'child']);
});

test('positive fractional sizes export as at least one pixel and all standard geometry becomes integral', () => {
  const scene = createScene('tiny');
  scene.nodes = [{ id: 'tiny', kind: 'text', text: '', x: -1.6, y: 4.4, width: .1, height: .4, color: 'neutral' }];
  const output = exportJsonCanvas(scene);
  assert.deepEqual([output.nodes[0].x, output.nodes[0].y, output.nodes[0].width, output.nodes[0].height], [-2, 4, 1, 1]);
  assert.equal(importJsonCanvas(output).scene.nodes[0].width, 1);
});

test('all six JSON Canvas presets round-trip and absent endpoints retain none/arrow defaults by omission', () => {
  const nodes = ['1', '2', '3', '4', '5', '6'].map((color, i) => ({ ...textNode(`node-${i}`), color }));
  const { scene } = importJsonCanvas({ nodes, edges: [{ id: 'edge', fromNode: 'node-0', toNode: 'node-1' }] });
  assert.deepEqual(scene.nodes.map(node => node.color), ['red', 'orange', 'yellow', 'green', 'cyan', 'purple']);
  assert.deepEqual(exportJsonCanvas(scene).nodes.map(node => node.color), ['1', '2', '3', '4', '5', '6']);
  assert.equal(Object.hasOwn(scene.edges[0], 'fromEnd'), false);
  assert.equal(Object.hasOwn(scene.edges[0], 'toEnd'), false);
  assert.equal(Object.hasOwn(exportJsonCanvas(scene).edges[0], 'fromEnd'), false);
});

test('unsupported node types, malformed files and mismatched SiYuan references never become silent empty imports', () => {
  assert.throws(() => importJsonCanvas('{broken'), /有效 JSON/);
  assert.throws(() => importJsonCanvas({ type: 'excalidraw', elements: [] }), /未识别/);
  assert.throws(() => importJsonCanvas({ nodes: 'not an array' }), /必须是数组/);
  assert.throws(() => importJsonCanvas({ nodes: [{ ...textNode(), type: 'drawing' }] }), /不支持/);
  assert.throws(() => importJsonCanvas({ nodes: [{ ...textNode(), color: '9' }] }), /颜色/);
  assert.throws(() => importJsonCanvas({ nodes: [{ ...textNode(), color: '#fff' }] }), /颜色/);
  assert.throws(() => importJsonCanvas({ nodes: [{ id: 'doc', type: 'file', ...geometry, file: `siyuan://blocks/${DOC}`, [EXT]: { kind: 'doc', docId: '20261017120001-bcdefgh' } }] }), /引用.*不一致/);
  assert.throws(() => importJsonCanvas({ nodes: [{ id: 'doc', type: 'file', ...geometry, file: `siyuan://blocks/${DOC}`, subpath: 'not-a-fragment' }] }), /以 #/);
  const blank = importJsonCanvas({});
  assert.equal(blank.scene.nodes.length, 0);
  assert.match(blank.warnings.join(''), /空画布/);
});

test('model validates extended fields without changing the shape of legacy scenes', () => {
  const old = createScene('legacy');
  old.nodes = [{ id: 'legacy', kind: 'text', text: 'old', ...geometry, color: 'neutral' }];
  old.edges = [{ id: 'orphan', from: 'legacy', to: 'missing', label: '', color: 'neutral' }];
  assert.deepEqual(normalizeScene(old), old);
  const extended = richScene();
  assert.deepEqual(normalizeScene(extended), extended);
  function invalid(value: unknown) { assert.throws(() => normalizeScene(value)); }
  invalid({ ...old, settings: { readOnly: 'true' } });
  invalid({ ...old, nodes: [{ id: 'bad', kind: 'file', file: '../outside', ...geometry, color: 'neutral' }] });
  invalid({ ...old, nodes: [{ id: 'bad', kind: 'file', file: 'javascript:alert(1)', unresolved: true, ...geometry, color: 'neutral' }] });
  invalid({ ...old, edges: [{ ...old.edges[0], fromEnd: 'circle' }] });
  invalid({ ...old, edges: [{ ...old.edges[0], toSide: 'center' }] });
  invalid({ ...old, nodes: [{ id: 'g', kind: 'group', title: 'g', background: 'javascript:alert(1)', ...geometry, color: 'neutral' }] });
});
