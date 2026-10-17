import type { WorkImage } from '@/types/workbench';

const safeCsp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`;

export function htmlFromArtifact(content: string, images: WorkImage[]): string | null {
  const fenced = content.match(/```(?:html|htm)\s*\n([\s\S]*?)\n```/i);
  const raw = (fenced?.[1] ?? '').trim();
  if (!raw || raw.length > 1_000_000) return null;
  let html = raw.replace(/asset:\/\/image-(\d+)/g, (_asset, number: string) => images[Number(number) - 1]?.dataUrl ?? '');
  if (!/<html[\s>]/i.test(html)) html = `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) html = html.replace(/<head(?:\s[^>]*)?>/i, head => `${head}<meta charset="utf-8">${safeCsp}`);
  else html = html.replace(/<html(?:\s[^>]*)?>/i, match => `${match}<head><meta charset="utf-8">${safeCsp}</head>`);
  return html;
}
