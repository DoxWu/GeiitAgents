import { useEffect, useRef } from 'react';

export function WebPagePreview({ html }: { html: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const platform = navigator.platform;
  const src = '__TAURI_INTERNALS__' in window
    ? /^(Win|Android)/.test(platform) ? 'http://geiit-preview.localhost/web-preview.html' : 'geiit-preview://localhost/web-preview.html'
    : '/web-preview.html';
  useEffect(() => {
    function ready(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null'
        || event.data?.type !== 'geiit-preview-ready') return;
      // Opaque sandbox origins cannot be addressed with a concrete targetOrigin.
      frame.current.contentWindow?.postMessage({ type: 'geiit-preview-render', html }, '*');
    }
    window.addEventListener('message', ready);
    return () => window.removeEventListener('message', ready);
  }, [html]);
  return <iframe ref={frame} title="生成的网页预览" sandbox="allow-scripts" referrerPolicy="no-referrer"
    src={src} className="h-[72vh] min-h-[520px] w-full border border-line bg-white" />;
}
