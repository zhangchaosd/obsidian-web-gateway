export type ScrollPosition = { line: number; fraction: number; end?: boolean };
export type ScrollHandle = { capture: () => ScrollPosition };
export const startPosition: ScrollPosition = { line: 1, fraction: 0 };

export function capturePreview(article: HTMLElement): ScrollPosition {
  if (article.scrollTop < 1) return startPosition;
  const top = article.getBoundingClientRect().top;
  const blocks = Array.from(article.querySelectorAll<HTMLElement>("[data-source-start]"));
  const block = blocks.filter(node => node.getBoundingClientRect().top <= top + 1).at(-1) ?? blocks[0];
  if (!block) return startPosition;
  const box = block.getBoundingClientRect();
  const start = Number(block.dataset.sourceStart);
  const count = Math.max(1, Number(block.dataset.sourceEnd) - start);
  const offset = Math.max(0, Math.min(.999, (top - box.top) / Math.max(1, box.height))) * count;
  return { line: start + Math.floor(offset), fraction: offset % 1,
    end: article.scrollHeight > article.clientHeight && article.scrollTop >= article.scrollHeight - article.clientHeight - 2 };
}

export function restorePreview(article: HTMLElement, position: ScrollPosition) {
  if (position.end) { article.scrollTop = article.scrollHeight; return; }
  if (position.line <= 1 && !position.fraction) { article.scrollTop = 0; return; }
  const blocks = Array.from(article.querySelectorAll<HTMLElement>("[data-source-start]"));
  const block = blocks.filter(node => Number(node.dataset.sourceStart) <= position.line).at(-1) ?? blocks[0];
  if (!block) return;
  const start = Number(block.dataset.sourceStart);
  const count = Math.max(1, Number(block.dataset.sourceEnd) - start);
  const fraction = Math.max(0, Math.min(1, (position.line - start + position.fraction) / count));
  article.scrollTop += block.getBoundingClientRect().top - article.getBoundingClientRect().top + block.getBoundingClientRect().height * fraction;
}
