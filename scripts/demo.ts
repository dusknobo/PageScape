import { createCanvasView } from '../src/canvas/view';
import type { CanvasScene } from '../src/canvas/types';

// Authored demonstration data only: this page never connects to a SiYuan kernel.
const scene: CanvasScene = {
  version: 1, id: '20261029000000-demo001', title: '流体力学 · 学习地图', revision: 'demo', updatedAt: Date.UTC(2026, 9, 29, 12),
  viewport: { x: 34, y: 28, zoom: 1 },
  nodes: [
    { id: 'concepts', kind: 'group', title: '基础概念', x: 0, y: 0, width: 370, height: 550, color: 'blue' },
    { id: 'equations', kind: 'doc', docId: '20261029000001-demo002', title: '控制方程', x: 24, y: 62, width: 320, height: 205, color: 'blue', groupId: 'concepts' },
    { id: 'boundary', kind: 'doc', docId: '20261029000002-demo003', title: '边界条件', x: 24, y: 310, width: 320, height: 205, color: 'blue', groupId: 'concepts' },
    { id: 'methods', kind: 'group', title: '数值方法', x: 430, y: 0, width: 370, height: 550, color: 'green' },
    { id: 'discrete', kind: 'text', text: '有限体积法\n\n将守恒方程写入每个控制体。\n关注面通量、网格与离散误差。', x: 454, y: 62, width: 320, height: 205, color: 'green', groupId: 'methods' },
    { id: 'solve', kind: 'text', text: '求解流程\n\n建模 → 网格 → 离散 → 求解\n\n检查残差与守恒误差，记录关键假设。', x: 454, y: 310, width: 320, height: 205, color: 'green', groupId: 'methods' },
    { id: 'validation', kind: 'doc', docId: '20261029000003-demo004', title: '验证与文献', x: 878, y: 62, width: 320, height: 205, color: 'purple' },
    { id: 'next', kind: 'text', text: '下一步\n\n□ 选择一个基准算例\n□ 比较不同网格下的结果\n□ 将结论整理回原始笔记', x: 878, y: 310, width: 320, height: 205, color: 'orange' },
  ],
  edges: [
    { id: 'e1', from: 'equations', to: 'discrete', label: '离散', color: 'blue', fromSide: 'right', toSide: 'left' },
    { id: 'e2', from: 'boundary', to: 'solve', label: '约束', color: 'blue', fromSide: 'right', toSide: 'left' },
    { id: 'e3', from: 'discrete', to: 'solve', label: '迭代', color: 'green', fromSide: 'bottom', toSide: 'top' },
    { id: 'e4', from: 'solve', to: 'validation', label: '验证', color: 'purple', fromSide: 'right', toSide: 'left' },
  ],
};
const noop = () => {};
const view = createCanvasView({
  element: document.getElementById('canvas')!, inline: true, onOpenCanvas: noop, onChange: noop,
  onOpenDocument: noop, onAddDocument: noop, onImportChildren: noop, onChooseBoard: noop,
  onNewBoard: noop, onRenameBoard: noop, onSave: noop, onReload: noop, onSaveCopy: noop,
  onRefresh: noop, onDrop: noop, onTemplates: noop, onReferences: noop,
  renderPreview(preview, target) {
    const body = document.createElement('div'); body.className = 'demo-preview';
    // These strings are authored immediately below, rather than read from notes.
    body.innerHTML = preview.dom; target.append(body); return () => body.remove();
  },
});
view.setScene(scene); view.setBoards([{ id: scene.id, title: scene.title, updatedAt: scene.updatedAt }]);
for (const [id, dom] of [
  ['20261029000001-demo002', '<p>从守恒定律理解流动。</p><ul><li>质量守恒</li><li>动量守恒</li><li>能量方程</li></ul>'],
  ['20261029000002-demo003', '<p>明确问题的输入与约束。</p><ul><li>入口与出口</li><li>壁面条件</li><li>初始状态</li></ul>'],
  ['20261029000003-demo004', '<p>将结果与基准解和文献对照。</p><p>记录误差、适用范围及可复现步骤。</p>'],
]) view.setPreview(id, { preview: { dom, eof: true } });
view.setStatus('画布内容自动保存到所属文档');
