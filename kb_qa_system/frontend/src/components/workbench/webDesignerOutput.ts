import type { WorkImage } from '@/types/workbench';

const safeCsp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`;

export function htmlFromArtifact(content: string, images: WorkImage[]): string | null {
  const fenced = content.match(/```(?:html|htm)\s*\n([\s\S]*?)\n```/i);
  const raw = (fenced?.[1] ?? '').trim();
  if (!raw || raw.length > 1_000_000) return null;
  // Repeated image placeholders must not expand a bounded model response into
  // an unbounded string before the preview/backup limits can run.
  let remaining = 7_990_000 - raw.length;
  let overflow = false;
  let html = raw.replace(/asset:\/\/image-(\d+)/g, (asset, number: string) => {
    const value = images[Number(number) - 1]?.dataUrl ?? '';
    remaining -= value.length - asset.length;
    if (remaining < 0 || overflow) { overflow = true; return ''; }
    return value;
  });
  if (overflow) return null;
  if (!/<html[\s>]/i.test(html)) html = `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) html = html.replace(/<head(?:\s[^>]*)?>/i, head => `${head}<meta charset="utf-8">${safeCsp}`);
  else html = html.replace(/<html(?:\s[^>]*)?>/i, match => `${match}<head><meta charset="utf-8">${safeCsp}</head>`);
  return html;
}
