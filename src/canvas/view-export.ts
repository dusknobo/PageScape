import type { CanvasScene } from './types';
import { bounds } from './view-geometry';
import { canvasVisibility } from './scene-features';

async function dataUrl(url: string, signal: AbortSignal): Promise<string> {
  const parsed = new URL(url, location.href);
  if (!['http:', 'https:', 'data:', 'blob:'].includes(parsed.protocol)) throw new Error('图片地址不支持安全导出');
  const response = await fetch(parsed.href, { signal, mode: 'cors', credentials: parsed.origin === location.origin ? 'same-origin' : 'omit' });
  if (!response.ok) throw new Error(`图片读取失败（HTTP ${response.status}）`);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onerror = () => reject(new Error('无法读取图片字节'));
    reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(blob);
  });
}

/** Rasterize the real, styled card DOM; an unreadable image fails visibly instead of disappearing. */
export async function canvasPng(scene: CanvasScene, world: HTMLElement, signal: AbortSignal): Promise<Blob> {
  const box = bounds(canvasVisibility(scene).nodes); if (!box) throw new Error('画布为空，没有可导出的节点');
  if (world.querySelector('iframe')) throw new Error('网页内容受浏览器跨域限制，无法完整导出。请先关闭卡片的网页预览，再导出带地址的卡片');
  await document.fonts.ready;
  const clone = world.cloneNode(true) as HTMLElement;
  const originals: Element[] = [world, ...world.querySelectorAll('*')];
  const copies: Element[] = [clone, ...clone.querySelectorAll('*')];
  for (let index = 0; index < originals.length; index++) {
    const source = originals[index]; const target = copies[index]; const computed = getComputedStyle(source);
    for (const name of [...source.attributes].map(attribute => attribute.name)) if (/^on/i.test(name) || (name === 'id' && !(source instanceof SVGElement)) || name === 'contenteditable') target.removeAttribute(name);
    const style = (target as HTMLElement | SVGElement).style;
    for (let i = 0; i < computed.length; i++) { const name = computed.item(i); style.setProperty(name, computed.getPropertyValue(name)); }
    for (const name of ['marker-start', 'marker-end']) {
      const marker = source.getAttribute(name)?.match(/#([^)"]+)/)?.[1]; if (marker) { target.setAttribute(name, `url(#${marker})`); style.setProperty(name, `url(#${marker})`); }
    }
    if (source instanceof HTMLTextAreaElement) target.textContent = source.value;
    if (source instanceof HTMLImageElement) {
      if (!source.complete || !source.naturalWidth) { try { await source.decode(); } catch { throw new Error(`图片尚未加载：${source.alt || source.src}`); } }
      (target as HTMLImageElement).src = await dataUrl(source.currentSrc || source.src, signal);
      target.removeAttribute('srcset'); target.removeAttribute('loading');
    }
    const background = computed.backgroundImage;
    if (/url\(/i.test(background)) {
      const urls = [...background.matchAll(/url\(["']?([^"')]+)["']?\)/g)]; let inlined = background;
      for (const match of urls) inlined = inlined.replace(match[0], `url("${await dataUrl(match[1], signal)}")`);
      style.backgroundImage = inlined;
    }
  }
  clone.querySelectorAll('.scv-node-port,.scv-node-resize,.scv-editor-close,.scv-edge-handle,.scv-node-tools').forEach(element => element.remove());
  for (const video of clone.querySelectorAll('video')) {
    const original = originals[copies.indexOf(video)] as HTMLVideoElement;
    if (original.readyState < 2) throw new Error('视频尚未载入，无法导出当前画面');
    const image = document.createElement('canvas'); image.width = original.videoWidth; image.height = original.videoHeight;
    image.getContext('2d')!.drawImage(original, 0, 0);
    try { const replacement = document.createElement('img'); replacement.src = image.toDataURL(); replacement.style.cssText = video.style.cssText; video.replaceWith(replacement); }
    catch { throw new Error('视频不允许跨域读取，无法完整导出'); }
  }
  clone.style.transform = 'none'; clone.style.left = `${32 - box.x}px`; clone.style.top = `${32 - box.y}px`;
  clone.style.width = `${box.width}px`; clone.style.height = `${box.height}px`;
  const width = Math.ceil(box.width + 64); const height = Math.ceil(box.height + 64);
  const scale = Math.min(2, 16384 / width, 16384 / height, Math.sqrt(32_000_000 / (width * height)));
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('画布范围无效，无法导出');
  const wrapper = document.createElement('div'); wrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  wrapper.style.cssText = `position:relative;width:${width}px;height:${height}px;overflow:hidden;background:${getComputedStyle(world.parentElement!).backgroundColor};`;
  wrapper.append(clone);
  const serialized = new XMLSerializer().serializeToString(wrapper);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${serialized}</foreignObject></svg>`;
  const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  const image = new Image(); image.src = svgUrl;
  try { await image.decode(); } catch { throw new Error('浏览器无法渲染画布快照，未生成缺失内容的图片'); }
  signal.throwIfAborted();
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d'); if (!context) throw new Error('浏览器不支持图片导出');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    try { canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG 编码失败，未生成图片')), 'image/png'); }
    catch { reject(new Error('有图片不允许跨域读取，无法完整导出；未生成缺失内容的图片')); }
  });
}
