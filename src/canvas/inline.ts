import { CanvasController } from './controller';
import { getDocumentContext, isDocumentReadonly } from '../context';
import type { SiyuanApi } from '../api';
import type { PreviewCache } from '../cache';
import type { CanvasControllerHost, CanvasStore } from './types';

interface InlineOptions {
  element: HTMLElement;
  docId: string;
  blockId: string;
  hostDocId?: string;
  host: CanvasControllerHost;
  api: SiyuanApi;
  cache: PreviewCache;
  store: CanvasStore;
  onDispose: () => void;
}

/** Keep one editor alive across native custom-block rerenders caused by its own saves. */
export class InlineCanvas {
  readonly controller: CanvasController;
  get anchor(): HTMLElement { return this.frame; }
  get docId(): string { return this.options.docId; }
  private frame: HTMLElement;
  private element: HTMLElement;
  private lifetime = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private attachment = 0;
  private closed = false;
  private lastReadonly = false;
  private focused?: { element: HTMLElement; start?: number | null; end?: number | null; direction?: 'forward' | 'backward' | 'none' | null };

  constructor(private options: InlineOptions) {
    this.element = options.element;
    const doc = this.element.ownerDocument;
    this.frame = doc.createElement('section');
    this.frame.className = 'scv-inline scv-doc-card';
    this.frame.contentEditable = 'false';
    this.frame.setAttribute('aria-label', '文档内 Canvas 画布');
    this.frame.dataset.canvasDocument = options.docId;
    this.frame.dataset.canvasHost = options.hostDocId || options.docId;
    const body = doc.createElement('div'); body.className = 'scv-inline-body';
    this.frame.append(body);
    const footer = doc.createElement('label'); footer.className = 'scv-inline-size';
    footer.append(doc.createTextNode('画布高度'));
    const range = doc.createElement('input'); range.type = 'range'; range.min = '360'; range.max = '1440'; range.step = '40';
    range.setAttribute('aria-label', '画布高度');
    const output = doc.createElement('output');
    const key = `scc-inline-height:${options.docId}:${options.blockId}`;
    let height = 640;
    try { const stored = Number(localStorage.getItem(key)); if (stored >= 360 && stored <= 1440) height = stored; } catch { /* Local view preferences are optional. */ }
    const resize = () => { body.style.height = `${range.value}px`; output.textContent = `${range.value} px`; };
    range.value = String(height); resize(); footer.append(range, output); this.frame.append(footer);
    range.addEventListener('input', resize, { signal: this.lifetime.signal });
    range.addEventListener('change', () => {
      try { localStorage.setItem(key, range.value); } catch { /* Keep the chosen height for this editor. */ }
      this.controller.check();
    }, { signal: this.lifetime.signal });
    this.controller = new CanvasController(body, options.docId, {
      ...options.host, inline: true, initialDocId: options.hostDocId || options.docId,
      isReadonly: () => this.readonly(),
    }, options.api, options.cache, options.store);
    // Canvas handles these inside the frame; the outer document must not also
    // insert text, move blocks, delete content, or run its own undo shortcuts.
    for (const type of ['keydown', 'keyup', 'beforeinput', 'input', 'change', 'compositionstart', 'compositionend',
      'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu',
      'dragstart', 'dragover', 'drop', 'paste', 'copy', 'cut', 'wheel']) {
      this.frame.addEventListener(type, event => event.stopPropagation(), { signal: this.lifetime.signal });
    }
  }

  private readonly(): boolean {
    if (this.element.isConnected && getDocumentContext(this.element)) this.lastReadonly = isDocumentReadonly(this.element);
    return this.lastReadonly;
  }

  attach(element: HTMLElement): () => void {
    clearTimeout(this.timer);
    this.element = element;
    const attachment = ++this.attachment;
    element.append(this.frame);
    const focused = this.focused; this.focused = undefined;
    queueMicrotask(() => {
      if (this.closed || this.attachment !== attachment || !this.frame.isConnected) return;
      const active = element.ownerDocument.activeElement;
      if (focused?.element.isConnected && (!active || active === element.ownerDocument.body || this.frame.contains(active))) {
        focused.element.focus({ preventScroll: true });
        if (focused.element instanceof HTMLTextAreaElement) focused.element.setSelectionRange(focused.start ?? 0, focused.end ?? 0, focused.direction ?? 'none');
      }
      void this.controller.storageChanged();
    });
    return () => {
      if (this.closed || this.attachment !== attachment) return;
      this.readonly();
      const active = element.ownerDocument.activeElement;
      if (active instanceof HTMLElement && this.frame.contains(active)) {
        this.focused = { element: active, ...(active instanceof HTMLTextAreaElement ? {
          start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection,
        } : {}) };
      }
      // A native save disposes and renders synchronously. A short grace period
      // also covers DOM replacement; a real document close still releases all listeners.
      this.timer = setTimeout(() => { void this.dispose(); }, 250);
    };
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer);
    this.options.onDispose();
    this.lifetime.abort();
    await this.controller.dispose();
    this.frame.remove();
  }
}
