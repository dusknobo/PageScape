import { canvasRequest } from './document-api';

interface PickerDocument { id: string; title: string; path: string }
interface PickerOptions { anchor: HTMLElement; mode: 'documents' | 'parent'; initialDocId?: string; signal?: AbortSignal; title?: string; hint?: string; confirmLabel?: string }

const ID = /^\d{14}-[a-z0-9]{7}$/;
const activePickers = new WeakMap<HTMLElement, () => void>();
let pickerSequence = 0;

function directId(value: string): string | undefined {
  if (ID.test(value)) return value;
  return /^siyuan:\/\/blocks\/(\d{14}-[a-z0-9]{7})(?:[?#][^\s]*)?$/.exec(value)?.[1];
}

function sqlLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

async function searchDocuments(value: string, signal: AbortSignal): Promise<PickerDocument[]> {
  const id = directId(value);
  // A freshly created document can be readable before the full-text index catches up.
  if (id) {
    const info = await canvasRequest<{ rootID: string; rootTitle?: string; path?: string }>('/api/block/getBlockInfo', { id }, signal);
    if (info.rootID !== id || !ID.test(info.rootID)) throw new Error('请使用文档 ID，而不是正文块 ID');
    const path = await canvasRequest<string>('/api/filetree/getHPathByID', { id }, signal);
    return [{ id, title: info.rootTitle || '未命名文档', path: typeof path === 'string' ? path : info.path || '' }];
  }
  // Escape LIKE metacharacters as well as SQL quotes: this is a literal title/path search.
  const pattern = '%' + value.replace(/[\\%_]/g, '\\$&') + '%';
  const where = id ? ` AND id=${sqlLiteral(id)}` : value ?
    ` AND (content LIKE ${sqlLiteral(pattern)} ESCAPE '\\' OR hpath LIKE ${sqlLiteral(pattern)} ESCAPE '\\')` : '';
  const stmt = `SELECT id,content,hpath FROM blocks WHERE type='d'${where} ORDER BY updated DESC LIMIT 30`;
  const response = await fetch('/api/query/sql', {
    method: 'POST', credentials: 'same-origin', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stmt, mode: 'readonly' }),
  });
  if (!response.ok) throw new Error(`搜索失败（HTTP ${response.status}）`);
  const payload: unknown = await response.json();
  signal.throwIfAborted();
  if (!payload || typeof payload !== 'object') throw new Error('搜索响应格式不正确');
  const result = payload as { code?: unknown; msg?: unknown; data?: unknown };
  if (result.code !== 0 || !Array.isArray(result.data)) {
    throw new Error(typeof result.msg === 'string' && result.msg ? result.msg.slice(0, 240) : '无法读取文档列表');
  }
  return result.data.slice(0, 30).flatMap((value: unknown) => {
    if (!value || typeof value !== 'object') return [];
    const row = value as { id?: unknown; content?: unknown; hpath?: unknown };
    if (typeof row.id !== 'string' || !ID.test(row.id)) return [];
    return [{ id: row.id, title: typeof row.content === 'string' && row.content ? row.content : '未命名文档',
      path: typeof row.hpath === 'string' ? row.hpath : '' }];
  });
}

/** Search is restricted to document metadata; this picker never reads or writes document bodies. */
export function pickCanvasDocuments(options: PickerOptions): Promise<string[] | null> {
  const { anchor, mode } = options;
  if (!anchor.isConnected || options.signal?.aborted) return Promise.resolve(null);
  activePickers.get(anchor)?.();
  if (!anchor.isConnected || options.signal?.aborted) return Promise.resolve(null);
  const doc = anchor.ownerDocument;
  const previousFocus = doc.activeElement;
  const originalPosition = anchor.style.position;
  const positioned = getComputedStyle(anchor).position === 'static';
  if (positioned) anchor.style.position = 'relative';
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const overlay = make('div', 'scc-canvas-picker');
  const styles = make('style');
  styles.textContent = `
    .scc-canvas-picker{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:#0005;padding:16px;box-sizing:border-box;font-size:14px;color:var(--b3-theme-on-background,#222)}
    .scc-canvas-picker *{box-sizing:border-box}
    .scc-canvas-picker-panel{width:min(620px,100%);max-height:100%;display:flex;flex-direction:column;gap:12px;padding:20px;background:var(--b3-theme-background,#fff);border:1px solid var(--b3-border-color,#ccc);border-radius:12px;box-shadow:0 12px 40px #0003;overflow:hidden}
    .scc-canvas-picker h2{margin:0;font-size:18px}.scc-canvas-picker-hint{margin:0;color:var(--b3-theme-on-surface,#666);font-size:12px}
    .scc-canvas-picker-search{width:100%;padding:10px 12px;border:1px solid var(--b3-border-color,#aaa);border-radius:6px;background:var(--b3-theme-background,#fff);color:inherit;font:inherit;outline-offset:2px}
    .scc-canvas-picker-results{min-height:100px;max-height:360px;overflow:auto;border:1px solid var(--b3-border-color,#ddd);border-radius:6px}
    .scc-canvas-picker-row{display:flex;align-items:center;gap:10px;padding:10px;cursor:pointer;border-bottom:1px solid var(--b3-border-color,#eee)}
    .scc-canvas-picker-row:last-child{border-bottom:0}.scc-canvas-picker-row:hover,.scc-canvas-picker-row.is-selected{background:var(--b3-theme-primary-lightest,#e9f1ff)}
    .scc-canvas-picker-copy{min-width:0;flex:1}.scc-canvas-picker-title,.scc-canvas-picker-path{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .scc-canvas-picker-path{font-size:12px;color:var(--b3-theme-on-surface,#666);margin-top:3px}
    .scc-canvas-picker-selection{display:flex;flex-wrap:wrap;gap:6px;max-height:90px;overflow:auto}
    .scc-canvas-picker-chip{max-width:100%;border:1px solid var(--b3-border-color,#ccc);border-radius:5px;padding:4px 8px;background:var(--b3-theme-surface,#f5f5f5);color:inherit;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;cursor:pointer}
    .scc-canvas-picker-status{min-height:18px;font-size:12px;color:var(--b3-theme-on-surface,#666)}
    .scc-canvas-picker-footer{display:flex;justify-content:flex-end;align-items:center;gap:10px}
    .scc-canvas-picker-footer button{padding:7px 15px;border-radius:6px;border:1px solid var(--b3-border-color,#bbb);background:var(--b3-theme-background,#fff);color:inherit;cursor:pointer;font:inherit}
    .scc-canvas-picker-footer .scc-canvas-picker-confirm{background:var(--b3-theme-primary,#3575d3);color:var(--b3-theme-on-primary,#fff);border-color:transparent}
    .scc-canvas-picker button:disabled{opacity:.45;cursor:default}
  `;
  const panel = make('div', 'scc-canvas-picker-panel');
  const title = make('h2', '', options.title || (mode === 'parent' ? '选择父文档' : '添加思源文档'));
  title.id = `scc-canvas-picker-title-${++pickerSequence}`;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', title.id);
  const hint = make('p', 'scc-canvas-picker-hint', options.hint || (mode === 'parent' ?
    '选择一个父文档。只搜索文档标题和路径。' : '搜索标题、路径，或粘贴文档 ID / 思源链接。可多选，输入 ID 后按回车选入。'));
  const input = make('input', 'scc-canvas-picker-search');
  input.type = 'search';
  input.placeholder = '输入标题、路径、文档 ID 或 siyuan://blocks/…';
  input.setAttribute('aria-label', '搜索思源文档');
  input.autocomplete = 'off';
  input.spellcheck = false;
  const selectedArea = make('div', 'scc-canvas-picker-selection');
  selectedArea.setAttribute('aria-label', '已选文档');
  const status = make('div', 'scc-canvas-picker-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const results = make('div', 'scc-canvas-picker-results');
  results.setAttribute('aria-label', '搜索结果');
  const footer = make('div', 'scc-canvas-picker-footer');
  const cancel = make('button', '', '取消');
  const confirm = make('button', 'scc-canvas-picker-confirm', options.confirmLabel || (mode === 'parent' ? '选择父文档' : '添加（0）'));
  cancel.type = confirm.type = 'button';
  confirm.disabled = true;
  footer.append(cancel, confirm);
  panel.append(title, hint, input, selectedArea, status, results, footer);
  overlay.append(styles, panel);
  anchor.append(overlay);

  return new Promise(resolve => {
    let closed = false;
    let revision = 0;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    let resultInputs: { document: PickerDocument; input: HTMLInputElement; row: HTMLLabelElement }[] = [];
    const selection = new Map<string, PickerDocument>();
    const events = new AbortController();
    const finish = (value: string[] | null) => {
      if (closed) return;
      closed = true;
      revision++;
      clearTimeout(debounce);
      request?.abort();
      events.abort();
      observer.disconnect();
      activePickers.delete(anchor);
      overlay.remove();
      if (positioned && anchor.style.position === 'relative') anchor.style.position = originalPosition;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
      resolve(value);
    };
    const observer = new MutationObserver(() => {
      if (!anchor.isConnected || !overlay.isConnected) finish(null);
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    activePickers.set(anchor, () => finish(null));
    options.signal?.addEventListener('abort', () => finish(null), { once: true, signal: events.signal });
    if (options.signal?.aborted) { finish(null); return; }

    const updateSelection = () => {
      selectedArea.replaceChildren();
      for (const item of selection.values()) {
        const chip = make('button', 'scc-canvas-picker-chip', item.title + ' ×');
        chip.type = 'button';
        chip.title = item.path;
        chip.setAttribute('aria-label', `移除所选文档：${item.title}`);
        chip.addEventListener('click', () => { selection.delete(item.id); updateSelection(); }, { signal: events.signal });
        selectedArea.append(chip);
      }
      for (const item of resultInputs) {
        item.input.checked = selection.has(item.document.id);
        item.row.classList.toggle('is-selected', item.input.checked);
      }
      confirm.disabled = selection.size === 0;
      confirm.textContent = options.confirmLabel || (mode === 'parent' ? '选择父文档' : `添加（${selection.size}）`);
    };
    const select = (item: PickerDocument, enabled: boolean) => {
      if (mode === 'parent') selection.clear();
      if (enabled) selection.set(item.id, item); else selection.delete(item.id);
      updateSelection();
    };
    const runSearch = async (selectDirect = false) => {
      if (closed || options.signal?.aborted) return;
      clearTimeout(debounce);
      request?.abort();
      const current = ++revision;
      const controller = new AbortController();
      request = controller;
      const value = input.value.trim().slice(0, 300);
      if (/^siyuan:/i.test(value) && !directId(value)) {
        status.textContent = '思源文档链接格式不正确，请使用 siyuan://blocks/文档ID。';
        results.replaceChildren();
        resultInputs = [];
        return;
      }
      status.textContent = '正在搜索…';
      try {
        const rows = await searchDocuments(value, controller.signal);
        if (closed || current !== revision) return;
        results.replaceChildren();
        resultInputs = [];
        for (const item of rows) {
          const row = make('label', 'scc-canvas-picker-row');
          const check = make('input');
          check.type = mode === 'parent' ? 'radio' : 'checkbox';
          check.name = title.id;
          check.setAttribute('aria-label', item.title);
          const copy = make('span', 'scc-canvas-picker-copy');
          copy.append(make('span', 'scc-canvas-picker-title', item.title), make('span', 'scc-canvas-picker-path', item.path || '/' + item.title));
          row.title = item.path;
          row.append(check, copy);
          check.addEventListener('change', () => select(item, check.checked), { signal: events.signal });
          results.append(row);
          resultInputs.push({ document: item, input: check, row });
        }
        if (selectDirect && directId(value) && rows.length === 1) select(rows[0], true);
        updateSelection();
        status.textContent = rows.length ? `${value ? '找到' : '最近更新的'} ${rows.length} 篇文档${rows.length === 30 ? '（最多显示 30 篇，请缩小关键词）' : ''}` :
          directId(value) ? '未找到该文档：请确认这是文档 ID，而不是段落块 ID。' : '没有找到匹配文档。';
      } catch (error) {
        if (closed || current !== revision || controller.signal.aborted) return;
        status.textContent = error instanceof Error ? error.message : '搜索失败，请稍后重试。';
        results.replaceChildren();
        resultInputs = [];
      }
    };
    input.addEventListener('input', () => {
      clearTimeout(debounce);
      request?.abort();
      revision++;
      status.textContent = '等待搜索…';
      debounce = setTimeout(() => { void runSearch(); }, 300);
    }, { signal: events.signal });
    overlay.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); finish(null); }
      else if (event.key === 'Enter' && event.target === input) {
        event.preventDefault();
        void runSearch(true);
      } else if (event.key === 'Tab') {
        const focusable = [...panel.querySelectorAll<HTMLElement>('input,button')].filter(element => !element.hasAttribute('disabled'));
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }, { signal: events.signal });
    overlay.addEventListener('click', event => {
      event.stopPropagation();
      if (event.target === overlay) finish(null);
    }, { signal: events.signal });
    cancel.addEventListener('click', () => finish(null), { signal: events.signal });
    confirm.addEventListener('click', () => { if (selection.size) finish([...selection.keys()]); }, { signal: events.signal });
    const initial = mode === 'parent' && options.initialDocId && ID.test(options.initialDocId) ? options.initialDocId : '';
    input.value = initial;
    void runSearch(Boolean(initial));
    queueMicrotask(() => { if (!closed) { input.focus(); input.select(); } });
  });
}
