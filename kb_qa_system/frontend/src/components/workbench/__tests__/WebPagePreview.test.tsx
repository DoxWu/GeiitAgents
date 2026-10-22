import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WebPagePreview } from '../WebPagePreview';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('only sends content to the current opaque frame after its ready message', () => {
  const { getByTitle, unmount } = render(<WebPagePreview html="<h1>private synthetic output</h1>" />);
  const frame = getByTitle('生成的网页预览') as HTMLIFrameElement;
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  expect(frame.getAttribute('src')).toBe('/web-preview.html');
  expect(frame.hasAttribute('srcdoc')).toBe(false);
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  const ready = (source: Window | null, origin: string, type = 'geiit-preview-ready') =>
    window.dispatchEvent(new MessageEvent('message', { source, origin, data: { type } }));
  ready(window, 'null');
  ready(frame.contentWindow, window.location.origin);
  ready(frame.contentWindow, 'null', 'unrelated');
  expect(post).not.toHaveBeenCalled();
  ready(frame.contentWindow, 'null');
  expect(post).toHaveBeenCalledExactlyOnceWith({ type: 'geiit-preview-render', html: '<h1>private synthetic output</h1>' }, '*');
  unmount();
  ready(null, 'null');
  expect(post).toHaveBeenCalledTimes(1);
});

it('uses the static unprivileged protocol in the desktop app', () => {
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  vi.stubGlobal('navigator', { platform: 'Win32' });
  const { getByTitle } = render(<WebPagePreview html="<p>example</p>" />);
  expect(getByTitle('生成的网页预览').getAttribute('src')).toBe('http://geiit-preview.localhost/web-preview.html');
});
