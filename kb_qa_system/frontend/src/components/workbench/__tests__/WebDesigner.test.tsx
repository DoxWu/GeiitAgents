import { expect, it } from 'vitest';
import { htmlFromArtifact } from '../webDesignerOutput';

it('embeds selected user images and applies an offline CSP to generated HTML', () => {
  const image = { name: 'hero.png', mimeType: 'image/png' as const, dataUrl: 'data:image/png;base64,iVBORw0KGgo=', bytes: 8 };
  const output = htmlFromArtifact('```html\n<!doctype html><html><head><title>Demo</title></head><body><img src="asset://image-1"></body></html>\n```', [image]);
  expect(output).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  expect(output).toContain("default-src 'none'");
  expect(output).toContain("connect-src 'none'");
  expect(output).toContain("script-src 'unsafe-inline'");
});

it('does not treat prose or an incomplete model response as a runnable page', () => {
  expect(htmlFromArtifact('Here is the HTML: <html><body>unsafe</body></html>', [])).toBeNull();
  expect(htmlFromArtifact('```html\n<body>unfinished', [])).toBeNull();
});
