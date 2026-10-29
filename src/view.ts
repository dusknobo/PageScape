import type { CardData, GalleryConfig, GalleryView, ViewOptions } from './types';

interface CardView {
  data: CardData;
  element: HTMLElement;
  dispose: () => void;
}

const BLOCK_ID = /^\d{14}-[a-z0-9]{7}$/;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function button(className: string, text: string, title?: string): HTMLButtonElement {
  const result = element('button', className, text);
  result.type = 'button';
  if (title) result.title = title;
  return result;
}

/** SiYuan stores emoji icons as Unicode code points; never interpret icon text as HTML. */
function documentIcon(icon: string, hasChildren: boolean): string {
  if (/^[0-9a-f]{4,6}(?:-[0-9a-f]{4,6})*$/i.test(icon)) {
    const points = icon.split('-').map((part) => Number.parseInt(part, 16));
    if (points.every((point) => point <= 0x10ffff && (point < 0xd800 || point > 0xdfff))) {
      try { return String.fromCodePoint(...points); } catch { /* Use the local fallback. */ }
    }
  }
  if (icon && !/[<>/\\]/.test(icon) && [...icon].length <= 8) return icon;
  return hasChildren ? '📁' : '📄';
}

export function createGalleryView(options: ViewOptions): GalleryView {
  let config: GalleryConfig = { ...options.config };
  let disposed = false;
  let cards = new Map<string, CardView>();
  const lifetime = new AbortController();
  const root = element('section', 'scc-root');
  root.contentEditable = 'false';
  root.setAttribute('aria-label', '子页卡片');
  const toolbar = element('div', 'scc-toolbar');
  const heading = element('span', 'scc-heading', '子页面');
  const actions = element('div', 'scc-actions');
  const refreshButton = button('scc-button scc-icon-button', '↻', '刷新子页卡片');
  refreshButton.setAttribute('aria-label', '刷新子页卡片');
  const settingsButton = button('scc-button', '设置');
  settingsButton.setAttribute('aria-expanded', 'false');
  actions.append(refreshButton, settingsButton);
  toolbar.append(heading, actions);

  const settings = element('form', 'scc-settings');
  settings.hidden = true;
  settings.setAttribute('aria-label', '子页卡片设置');
  const fields = element('div', 'scc-settings-fields');
  const columnsLabel = element('label', 'scc-setting');
  columnsLabel.append(element('span', 'scc-setting-name', '列数'));
  const columns = element('select', 'scc-select');
  for (const value of [0, 1, 2, 3, 4]) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = value === 0 ? '自动' : `${value} 列`;
    columns.append(option);
  }
  columnsLabel.append(columns);
  const heightLabel = element('label', 'scc-setting scc-height-setting');
  const heightCaption = element('span', 'scc-setting-name');
  const heightValue = element('output', 'scc-height-value');
  heightCaption.append(document.createTextNode('预览高度 '), heightValue);
  const height = element('input', 'scc-range');
  height.type = 'range';
  height.min = '140';
  height.max = '400';
  height.step = '10';
  heightLabel.append(heightCaption, height);
  const imageLabel = element('label', 'scc-check-setting');
  const showImages = element('input', 'scc-checkbox');
  showImages.type = 'checkbox';
  imageLabel.append(showImages, document.createTextNode('显示图片'));
  const automaticLabel = element('label', 'scc-check-setting');
  const autoRefresh = element('input', 'scc-checkbox');
  autoRefresh.type = 'checkbox';
  automaticLabel.append(autoRefresh, document.createTextNode('自动更新'));
  fields.append(columnsLabel, heightLabel, imageLabel, automaticLabel);
  const settingsBottom = element('div', 'scc-settings-bottom');
  const settingsHelp = element('span', 'scc-settings-help', '设置仅影响当前卡片块');
  const applyButton = button('scc-button scc-primary-button', '应用');
  applyButton.type = 'submit';
  settingsBottom.append(settingsHelp, applyButton);
  settings.append(fields, settingsBottom);

  const status = element('div', 'scc-status');
  status.hidden = true;
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const grid = element('div', 'scc-grid');
  const empty = element('div', 'scc-empty', '正在读取子页面…');
  const footer = element('div', 'scc-footer');
  const loadMore = button('scc-button scc-load-more', '加载更多子页');
  footer.hidden = true;
  footer.append(loadMore);
  root.append(toolbar, settings, status, grid, empty, footer);
  options.element.append(root);

  function syncConfig(): void {
    root.dataset.columns = String(config.columns);
    root.style.setProperty('--scc-preview-height', `${config.previewHeight}px`);
    columns.value = String(config.columns);
    height.value = String(config.previewHeight);
    heightValue.value = `${config.previewHeight}px`;
    showImages.checked = config.showImages;
    autoRefresh.checked = config.autoRefresh;
  }

  function setStatus(message: string, error = false): void {
    if (disposed) return;
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle('scc-status-error', error);
  }

  function refresh(): void {
    if (disposed) return;
    setStatus('正在刷新…');
    try { options.onRefresh(); } catch { setStatus('刷新失败，请稍后重试。', true); }
  }

  function createCard(data: CardData): CardView {
    const cardLifetime = new AbortController();
    const card = element('article', 'scc-card');
    card.dataset.docId = data.doc.id;
    const titleButton = button('scc-card-title', '');
    titleButton.title = `打开：${data.doc.title}`;
    const icon = element('span', 'scc-card-icon', documentIcon(data.doc.icon, data.doc.childCount > 0));
    icon.setAttribute('aria-hidden', 'true');
    titleButton.append(icon, element('span', 'scc-card-name', data.doc.title || '未命名文档'));
    titleButton.addEventListener('click', () => options.onOpen(data.doc.id), { signal: cardLifetime.signal });
    card.append(titleButton);
    let cleanupPreview: (() => void) | undefined;
    let resize: ResizeObserver | undefined;
    let mutations: MutationObserver | undefined;
    let measureFrame = 0;

    const showError = (message: string): void => {
      const error = element('div', 'scc-card-error');
      const retry = button('scc-retry', '刷新重试');
      retry.addEventListener('click', refresh, { signal: cardLifetime.signal });
      error.append(element('span', 'scc-error-message', message), retry);
      card.append(error);
    };

    if (data.error) {
      showError(data.error);
    } else if (data.preview?.dom.trim()) {
      const viewport = element('div', 'scc-preview');
      const body = element('div', 'scc-preview-body');
      viewport.append(body);
      card.append(viewport);
      const measure = (): void => {
        if (measureFrame || disposed) return;
        measureFrame = requestAnimationFrame(() => {
          measureFrame = 0;
          if (!cardLifetime.signal.aborted && viewport.isConnected) {
            viewport.classList.toggle('scc-overflow', body.scrollHeight > viewport.clientHeight + 2);
          }
        });
      };
      try {
        cleanupPreview = options.renderPreview(data.preview, body, config.showImages);
        if (typeof ResizeObserver !== 'undefined') {
          resize = new ResizeObserver(measure);
          resize.observe(body);
          resize.observe(viewport);
        }
        if (typeof MutationObserver !== 'undefined') {
          mutations = new MutationObserver(measure);
          mutations.observe(body, { childList: true, subtree: true, characterData: true, attributes: true });
        }
        viewport.addEventListener('load', measure, { capture: true, signal: cardLifetime.signal });
        measure();
      } catch {
        viewport.remove();
        showError('预览暂不可用');
      }
    } else if (data.children?.length) {
      const children = element('div', 'scc-child-links');
      for (const child of data.children) {
        const childButton = button('scc-child-link', '');
        const childIcon = element('span', 'scc-child-icon', documentIcon(child.icon, child.childCount > 0));
        childIcon.setAttribute('aria-hidden', 'true');
        childButton.append(childIcon, element('span', 'scc-child-name', child.title || '未命名文档'));
        childButton.title = child.title;
        childButton.addEventListener('click', () => options.onOpen(child.id), { signal: cardLifetime.signal });
        children.append(childButton);
      }
      card.append(children);
    } else if (data.preview !== undefined || data.children !== undefined) {
      card.append(element('div', 'scc-card-empty', '暂无内容'));
    } else {
      card.append(element('div', 'scc-card-loading', '正在加载预览…'));
      card.setAttribute('aria-busy', 'true');
    }

    return {
      data,
      element: card,
      dispose() {
        cardLifetime.abort();
        resize?.disconnect();
        mutations?.disconnect();
        if (measureFrame) cancelAnimationFrame(measureFrame);
        try { cleanupPreview?.(); } catch { /* Continue disposing the other cards. */ }
      },
    };
  }

  function clearCards(): void {
    for (const card of cards.values()) card.dispose();
    cards.clear();
    grid.replaceChildren();
  }

  function updateCard(data: CardData): void {
    if (disposed) return;
    const oldCard = cards.get(data.doc.id);
    if (!oldCard) return;
    const card = createCard(data);
    oldCard.dispose();
    oldCard.element.replaceWith(card.element);
    cards.set(data.doc.id, card);
  }

  refreshButton.addEventListener('click', refresh, { signal: lifetime.signal });
  loadMore.addEventListener('click', () => {
    try { options.onLoadMore(); } catch { setStatus('加载失败，请刷新后重试。', true); }
  }, { signal: lifetime.signal });
  settingsButton.addEventListener('click', () => {
    settings.hidden = !settings.hidden;
    settingsButton.setAttribute('aria-expanded', String(!settings.hidden));
    if (!settings.hidden) {
      syncConfig();
      settingsHelp.textContent = '设置仅影响当前卡片块';
      settingsHelp.classList.remove('scc-settings-error');
    }
  }, { signal: lifetime.signal });
  height.addEventListener('input', () => { heightValue.value = `${height.value}px`; }, { signal: lifetime.signal });
  settings.addEventListener('submit', (event) => {
    event.preventDefault();
    const next: GalleryConfig = {
      version: 1,
      columns: Number(columns.value) as GalleryConfig['columns'],
      previewHeight: Math.max(140, Math.min(400, Number(height.value) || 200)),
      showImages: showImages.checked,
      autoRefresh: autoRefresh.checked,
    };
    let saved = false;
    try { saved = options.onConfig(next); } catch { /* A read-only or detached block cannot be saved. */ }
    if (!saved) {
      settingsHelp.textContent = '保存失败：当前块可能只读，请切换到可编辑文档后重试。';
      settingsHelp.classList.add('scc-settings-error');
      setStatus('卡片设置未保存，仍使用原设置。', true);
      return;
    }
    const imagesChanged = config.showImages !== next.showImages;
    config = next;
    syncConfig();
    settings.hidden = true;
    settingsButton.setAttribute('aria-expanded', 'false');
    // Image visibility changes need a new native preview instance; layout-only changes do not.
    if (imagesChanged) for (const card of [...cards.values()]) updateCard(card.data);
    setStatus('设置已保存');
  }, { signal: lifetime.signal });

  root.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const preview = target?.closest('.scc-preview');
    if (!preview || !root.contains(preview)) return;
    const blockRef = target?.closest<HTMLElement>('[data-type="block-ref"][data-id]');
    const anchor = target?.closest<HTMLAnchorElement>('a[href]');
    let blockId = blockRef?.dataset.id;
    const href = anchor?.getAttribute('href') || '';
    if (!blockId) blockId = /^siyuan:\/\/blocks\/(\d{14}-[a-z0-9]{7})(?:[/?#]|$)/i.exec(href)?.[1];
    if (blockId && BLOCK_ID.test(blockId)) {
      event.preventDefault();
      event.stopPropagation();
      options.onOpen(blockId);
      return;
    }
    if (!anchor) return;
    if (/^https?:\/\//i.test(href)) {
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
    } else {
      event.preventDefault();
    }
    event.stopPropagation();
  }, { signal: lifetime.signal });

  syncConfig();
  return {
    setLoading() {
      if (disposed) return;
      clearCards();
      heading.textContent = '子页面';
      empty.textContent = '正在读取子页面…';
      empty.hidden = false;
      footer.hidden = true;
      root.setAttribute('aria-busy', 'true');
    },
    setCards(data, hasMore) {
      if (disposed) return;
      clearCards();
      cards = new Map();
      for (const item of data) {
        if (cards.has(item.doc.id)) continue;
        const card = createCard(item);
        cards.set(item.doc.id, card);
        grid.append(card.element);
      }
      heading.textContent = `子页面 · ${cards.size}${hasMore ? '+' : ''}`;
      empty.textContent = '还没有子页面';
      empty.hidden = cards.size > 0;
      footer.hidden = !hasMore;
      root.removeAttribute('aria-busy');
    },
    updateCard,
    setStatus,
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      clearCards();
      root.remove();
    },
  };
}
