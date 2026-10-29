import { Protyle } from 'siyuan';
import type { App } from 'siyuan';
import { SiyuanApi } from '../api';
import { resolveCanvasDocumentTarget } from './document-target';

export interface CanvasDocumentEditor {
  ready: Promise<void>;
  close(): Promise<void>;
}

interface EditorOptions { signal: AbortSignal; subpath?: string; onError(error: unknown): void; onClosed(): void }
type FlushableProtyle = Protyle & { flushPendingTransactions?: () => Promise<void> };

/** A native editor inside an independent Canvas tab, never inside a custom block renderer. */
export function mountCanvasDocumentEditor(app: App, target: HTMLElement, blockId: string, options: EditorOptions): CanvasDocumentEditor {
  if (target.closest('[data-type="NodeCustomBlock"]')) throw new Error('自定义正文块内不支持嵌套原生编辑器，请先打开独立 Canvas 页签');
  if (!/^\d{14}-[a-z0-9]{7}$/.test(blockId)) throw new Error('文档 ID 无效');
  const events = new AbortController();
  const signal = AbortSignal.any([options.signal, events.signal]);
  const mount = target.ownerDocument.createElement('div');
  mount.className = 'scv-native-protyle'; mount.style.cssText = 'width:100%;height:100%;min-height:120px;overflow:hidden';
  target.classList.add('scv-native-editor'); target.replaceChildren(mount); mount.textContent = '正在打开原文…';
  let editor: FlushableProtyle | undefined;
  let closing = false;
  let closeTask: Promise<void> | undefined;
  const observer = new MutationObserver(() => { if (!target.isConnected) void close(); });
  const resize = new ResizeObserver(() => { if (!closing && editor) editor.resize(); });
  const ready = (async () => {
    try {
      const doc = await new SiyuanApi().resolveDocument(blockId, signal);
      const targetId = await resolveCanvasDocumentTarget(doc, options.subpath, signal);
      if (closing || signal.aborted || !target.isConnected) return;
      editor = new Protyle(app, mount, {
        blockId: targetId, rootId: doc.id, notebookId: doc.notebook, mode: 'wysiwyg', action: ['cb-get-focus'],
        render: { background: false, title: false, breadcrumb: false, gutter: true, scroll: true },
        after: instance => { if (!closing) { instance.resize(); instance.focus(); } },
      });
      resize.observe(target);
    } catch (error) {
      if (!closing && !signal.aborted) { mount.textContent = `原文编辑器无法打开：${error instanceof Error ? error.message : String(error)}`; options.onError(error); }
    }
  })();
  function close(): Promise<void> {
    if (closeTask) return closeTask;
    closing = true;
    events.abort(); observer.disconnect(); resize.disconnect();
    closeTask = (async () => {
      await ready;
      try {
        if (editor) {
          const focused = target.ownerDocument.activeElement;
          if (focused instanceof HTMLElement && mount.contains(focused)) focused.blur();
          // SiYuan 3.8.7 exposes this at runtime; older supported versions still use native destroy.
          await editor.flushPendingTransactions?.();
        }
      } catch (error) { options.onError(error); }
      finally {
        editor?.destroy(); editor = undefined; mount.remove();
        if (!target.querySelector('.scv-native-protyle')) target.classList.remove('scv-native-editor');
        options.onClosed();
      }
    })();
    return closeTask;
  }
  options.signal.addEventListener('abort', () => { void close(); }, { once: true, signal: events.signal });
  if (options.signal.aborted) void close();
  else observer.observe(target.ownerDocument.documentElement, { childList: true, subtree: true });
  return { ready, close };
}
