import { SiyuanApi } from '../api';
import { listCanvasNotebooks } from './document-api';
import { pickCanvasDocuments } from './picker';
import type { CanvasDestination } from './types';

const active = new WeakMap<HTMLElement, () => void>();
export interface CanvasDestinationOptions { title?: string; askTitle?: boolean; signal?: AbortSignal }

/** A document location is explicit for creation; cancellation never creates a document. */
export async function chooseCanvasDestination(anchor: HTMLElement, initialDocId?: string, options: CanvasDestinationOptions = {}): Promise<CanvasDestination | null> {
  if (!anchor.isConnected || options.signal?.aborted) return null;
  const books = await listCanvasNotebooks();
  if (!books.length) throw new Error('请先打开一个可写笔记本');
  if (!anchor.isConnected || options.signal?.aborted) return null;
  let parent: { id: string; notebook: string; title: string } | undefined;
  if (initialDocId) {
    try { parent = await new SiyuanApi().resolveDocument(initialDocId, options.signal); } catch { /* The user can choose another location. */ }
  }
  if (parent && !books.some(book => book.id === parent!.notebook)) parent = undefined;
  if (!anchor.isConnected || options.signal?.aborted) return null;
  active.get(anchor)?.();
  return new Promise(resolve => {
    const doc = anchor.ownerDocument;
    const previousFocus = doc.activeElement as HTMLElement | null;
    const overlay = doc.createElement('div'); overlay.className = 'scv-destination-overlay';
    overlay.style.cssText = 'position:absolute;inset:0;z-index:110;display:flex;align-items:center;justify-content:center;padding:16px;background:#0005';
    const panel = doc.createElement('form'); panel.className = 'scv-destination';
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '选择画布文档保存位置'); panel.setAttribute('aria-modal', 'true');
    panel.style.cssText = 'display:flex;flex-direction:column;gap:14px;max-width:100%;width:450px;padding:22px;border-radius:10px;background:var(--b3-theme-background,#fff);color:var(--b3-theme-on-background,#222);box-shadow:0 8px 40px #0004;font:14px/1.5 var(--b3-font-family,sans-serif)';
    const title = doc.createElement('strong'); title.textContent = '选择画布文档保存位置';
    const hint = doc.createElement('p'); hint.textContent = '画布将保存为普通思源文档，可在文档树中移动和重命名。'; hint.style.margin = '0';
    const nameLabel = doc.createElement('label'); nameLabel.style.cssText = 'display:flex;flex-direction:column;gap:6px';
    nameLabel.append(doc.createTextNode('画布名称'));
    const name = doc.createElement('input'); name.type = 'text'; name.className = 'b3-text-field scv-destination-name';
    name.value = options.title?.trim() || '新画布'; name.maxLength = 300; name.autocomplete = 'off';
    name.setAttribute('aria-label', '画布名称'); name.setAttribute('aria-required', 'true');
    name.style.cssText = 'width:100%;min-width:0;box-sizing:border-box'; nameLabel.append(name);
    const label = doc.createElement('label'); label.textContent = '笔记本';
    const select = doc.createElement('select'); select.setAttribute('aria-label', '保存到笔记本'); select.className = 'b3-select';
    for (const book of books) { const option = doc.createElement('option'); option.value = book.id; option.textContent = book.name; select.append(option); }
    if (parent) select.value = parent.notebook;
    label.append(select); label.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px';
    const location = doc.createElement('span');
    const updateLocation = () => { location.textContent = parent ? `父文档：${parent.title}` : '位置：所选笔记本根目录'; };
    updateLocation();
    const buttons = doc.createElement('div'); buttons.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px';
    const makeButton = (name: string) => { const b = doc.createElement('button'); b.type = 'button'; b.textContent = name; b.className = 'b3-button b3-button--outline'; return b; };
    const chooseParent = makeButton('选择父文档'); const root = makeButton('放在根目录');
    buttons.append(chooseParent, root);
    const status = doc.createElement('span'); status.setAttribute('role', 'status');
    const footer = doc.createElement('div'); footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px';
    const cancel = makeButton('取消'); const accept = makeButton('保存到这里'); accept.type = 'submit';
    footer.append(cancel, accept); panel.append(title, hint);
    if (options.askTitle) panel.append(nameLabel);
    panel.append(label, location, buttons, status, footer); overlay.append(panel);
    const previousPosition = anchor.style.position;
    if (getComputedStyle(anchor).position === 'static') anchor.style.position = 'relative';
    anchor.append(overlay);
    let finished = false;
    const observer = new MutationObserver(() => { if (!anchor.isConnected || !overlay.isConnected) finish(null); });
    const lifetime = new AbortController();
    const finish = (result: CanvasDestination | null) => {
      if (finished) return; finished = true; observer.disconnect(); lifetime.abort(); overlay.remove();
      anchor.style.position = previousPosition; active.delete(anchor);
      if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus();
      resolve(result);
    };
    active.set(anchor, () => finish(null));
    options.signal?.addEventListener('abort', () => finish(null), { once: true, signal: lifetime.signal });
    observer.observe(doc.body, { childList: true, subtree: true });
    const validName = () => {
      if (!options.askTitle) return true;
      const value = name.value.trim();
      const valid = value.length > 0 && value.length <= 300;
      accept.disabled = !valid; name.setAttribute('aria-invalid', String(!valid));
      return valid;
    };
    name.addEventListener('input', () => {
      status.textContent = validName() ? '' : name.value.trim() ? '画布名称最多 300 个字符' : '请输入画布名称';
    }, { signal: lifetime.signal });
    select.addEventListener('change', () => { parent = undefined; updateLocation(); }, { signal: lifetime.signal });
    root.addEventListener('click', () => { parent = undefined; updateLocation(); }, { signal: lifetime.signal });
    chooseParent.addEventListener('click', async () => {
      overlay.style.visibility = 'hidden';
      try {
        const ids = await pickCanvasDocuments({ anchor, mode: 'parent', initialDocId: parent?.id, signal: lifetime.signal });
        if (finished) return; overlay.style.visibility = ''; chooseParent.focus();
        if (!ids?.[0]) return;
        const candidate = await new SiyuanApi().resolveDocument(ids[0], lifetime.signal);
        if (finished) return;
        if (!books.some(book => book.id === candidate.notebook)) throw new Error('父文档所在笔记本不可写');
        parent = candidate; select.value = candidate.notebook; updateLocation(); status.textContent = '';
      } catch (error) { if (!finished) status.textContent = error instanceof Error ? error.message : '无法选择父文档'; }
      finally { if (!finished) overlay.style.visibility = ''; }
    }, { signal: lifetime.signal });
    cancel.addEventListener('click', () => finish(null), { signal: lifetime.signal });
    panel.addEventListener('submit', event => {
      event.preventDefault();
      if (!validName()) { status.textContent = '请输入 1 至 300 个字符的画布名称'; name.focus(); return; }
      finish({ notebook: select.value, ...(parent ? { parentId: parent.id } : {}), ...(options.askTitle ? { title: name.value.trim() } : {}) });
    }, { signal: lifetime.signal });
    // Canvas listens in its own capture phase. Stop this dialog's keyboard
    // events earlier, without cancelling native text selection or form submit.
    doc.addEventListener('keydown', event => {
      if (!(event.target instanceof Node) || !panel.contains(event.target)) return;
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(null); }
      if (event.key === 'Tab') {
        const controls = [...(options.askTitle ? [name] : []), select, chooseParent, root, cancel, accept].filter(control => !control.disabled);
        const index = controls.indexOf(doc.activeElement as HTMLButtonElement);
        if (event.shiftKey && index === 0) { event.preventDefault(); controls[controls.length - 1].focus(); }
        else if (!event.shiftKey && index === controls.length - 1) { event.preventDefault(); controls[0].focus(); }
      }
    }, { capture: true, signal: lifetime.signal });
    validName();
    if (options.askTitle) { name.focus(); name.select(); } else select.focus();
  });
}
