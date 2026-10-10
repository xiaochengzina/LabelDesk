/**
 * 图片解码缓存。
 *
 * 画布渲染是同步的，而图片解码是异步的，因此这里维护一个
 * 「dataUrl → HTMLImageElement」的缓存：首次访问触发异步加载并在完成后
 * 通知订阅者重绘，之后所有渲染都命中同步路径。
 */

const cache = new Map<string, HTMLImageElement>();
const pending = new Map<string, Promise<HTMLImageElement>>();
const listeners = new Set<() => void>();

/** 订阅「有新图片解码完成」，用于触发画布重绘。返回取消订阅函数。 */
export function onImageLoaded(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** 同步取已解码的图片；未就绪返回 undefined（调用方应先调 loadImage）。 */
export function getImageSync(dataUrl: string): HTMLImageElement | undefined {
  if (!dataUrl) return undefined;
  const cached = cache.get(dataUrl);
  if (cached && cached.complete && cached.naturalWidth > 0) return cached;
  return undefined;
}

/** 预加载并缓存图片。同一个 dataUrl 只会解码一次。 */
export function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  if (!dataUrl) return Promise.reject(new Error("图片地址为空"));
  const ready = getImageSync(dataUrl);
  if (ready) return Promise.resolve(ready);

  const existing = pending.get(dataUrl);
  if (existing) return existing;

  const task = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      cache.set(dataUrl, img);
      pending.delete(dataUrl);
      notify();
      resolve(img);
    };
    img.onerror = () => {
      pending.delete(dataUrl);
      reject(new Error("图片解码失败"));
    };
    img.src = dataUrl;
  });

  pending.set(dataUrl, task);
  return task;
}

/** 预加载模板里所有图片元素（切换模板时调用）。 */
export function preloadImages(dataUrls: string[]): void {
  for (const url of dataUrls) {
    if (url && !getImageSync(url)) {
      loadImage(url).catch(() => undefined);
    }
  }
}

/** 释放不再使用的图片，避免长时间编辑后内存持续增长。 */
export function releaseUnused(keep: Set<string>): void {
  for (const key of [...cache.keys()]) {
    if (!keep.has(key)) cache.delete(key);
  }
}
