const hostScript = String.raw`(function () {
  const surface = document.getElementById('stream-surface');
  const style = document.getElementById('extra-stream-styles');
  const tags = new Set('div span header footer main section article figure figcaption p h1 h2 h3 h4 strong em b i small br ul ol li dl dt dd table thead tbody tr th td svg g defs title desc circle ellipse path line polygon polyline rect text tspan linearGradient radialGradient stop clipPath mask marker'.toLowerCase().split(' '));
  const attrs = new Set('id class style title role data-prompt data-no-prompt data-voice-prompt viewBox preserveAspectRatio width height x y x1 y1 x2 y2 cx cy r rx ry d points fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray opacity transform text-anchor dominant-baseline alignment-baseline font-size font-weight font-family dx dy offset stop-color stop-opacity gradientUnits gradientTransform fx fy fr clip-path clip-rule mask marker-end marker-start markerWidth markerHeight refX refY orient vector-effect'.toLowerCase().split(' '));
  let canvasDone = false;
  let lastHtml = '';

  // Parse inertly, then keep only static layout and geometric drawing nodes.
  function staticContent(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    for (const node of template.content.querySelectorAll('*')) {
      if (!tags.has(node.localName.toLowerCase())) { node.remove(); continue; }
      for (const attr of Array.from(node.attributes)) {
        if (!attrs.has(attr.name.toLowerCase()) && !/^aria-[a-z-]+$/.test(attr.name)) node.removeAttributeNode(attr);
      }
    }
    return template.content;
  }
  function normalized(text) { return (text || '').replace(/\s+/g, ' ').trim(); }
  function visible(el) {
    const css = getComputedStyle(el);
    return css.display !== 'none' && css.visibility !== 'hidden' && el.getClientRects().length > 0;
  }
  function labelOf(el) {
    const aria = normalized(el.getAttribute('aria-label'));
    if (aria) return aria;
    if (el.namespaceURI === 'http://www.w3.org/2000/svg') {
      const title = Array.from(el.children).find(child => child.localName === 'title');
      if (title && normalized(title.textContent)) return normalized(title.textContent);
      if (el.localName === 'text') return visible(el) ? normalized(el.textContent) : '';
      return normalized(Array.from(el.querySelectorAll('text')).filter(text => !text.closest('defs') && visible(text)).map(text => text.textContent).join(' '));
    }
    return normalized(el.innerText);
  }
  function implicitBlock(target) {
    if (target === surface || target.closest('[data-no-prompt], defs, [role="button"]')) return null;
    const svg = target.closest('svg');
    if (svg) {
      if (target === svg) return null;
      if (/^(rect|path|polygon)$/.test(target.localName) && !labelOf(target)) {
        const bounds = target.getBoundingClientRect(), total = svg.getBoundingClientRect();
        if (total.width && total.height && bounds.width >= total.width * .8 && bounds.height >= total.height * .8) return null;
      }
      const total = labelOf(svg).length, multi = svg.querySelectorAll('g').length > 1;
      for (let group = target; group && group !== svg; group = group.parentElement) {
        if (group.localName !== 'g') continue;
        const label = labelOf(group);
        const branches = Array.from(group.children).filter(child => child.localName === 'g' && labelOf(child)).length;
        if (label && label.length <= 120 && branches < 2 && (!multi || !total || label.length < total * .85 || group.getAttribute('aria-label'))) return { element: group, label };
      }
      const text = target.closest('text'), label = text && labelOf(text);
      if (label && label.length <= 120) return { element: text, label };
    }
    const block = target.closest('section, article, li, tr, figure, dd, dt');
    const label = block && labelOf(block);
    return label && label.length <= 120 && label.length < normalized(surface.innerText).length * .85 ? { element: block, label } : null;
  }
  surface.addEventListener('click', function (event) {
    if (!canvasDone || event.defaultPrevented || !(event.target instanceof Element) || event.target.closest('[data-no-prompt]')) return;
    const explicit = event.target.closest('[data-prompt], [data-voice-prompt]');
    const hit = explicit && surface.contains(explicit)
      ? { element: explicit, label: normalized(explicit.getAttribute('data-prompt') || explicit.getAttribute('data-voice-prompt')) }
      : implicitBlock(event.target);
    if (!hit || !hit.label) return;
    hit.element.classList.add('canvas-tap-flash');
    setTimeout(() => hit.element.classList.remove('canvas-tap-flash'), 450);
    window.parent.postMessage({ type: 'her-canvas-interact', text: hit.label.slice(0, 400) }, '*');
  });
  function fitCanvas() {
    const width = window.innerWidth, height = window.innerHeight;
    if (!width || !height) return;
    surface.style.transform = '';
    const rect = surface.getBoundingClientRect();
    const sw = Math.max(rect.width, surface.scrollWidth), sh = Math.max(rect.height, surface.scrollHeight);
    const scale = Math.min(1, width / sw, height / sh);
    surface.style.transformOrigin = sw > width ? 'top left' : 'top center';
    if (scale < .999) surface.style.transform = 'scale(' + Math.floor(scale * 10000) / 10000 + ')';
  }
  window.addEventListener('resize', fitCanvas);
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(fitCanvas);
    observer.observe(document.documentElement);
    observer.observe(surface);
  }
  window.__herUpdateCanvas = function (payload) {
    canvasDone = payload.done === true;
    if (style.textContent !== payload.styles) style.textContent = payload.styles;
    if (lastHtml !== payload.html) {
      surface.replaceChildren(staticContent(payload.html));
      lastHtml = payload.html;
    }
    fitCanvas();
  };
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || event.data?.type !== 'her-canvas-update') return;
    const p = event.data.payload;
    if (p && typeof p.html === 'string' && typeof p.styles === 'string') window.__herUpdateCanvas(p);
  });
})();`;

// SHA-256 of the exact inline hostScript above. Recalculate on edits; a test guards the hash.
const hostScriptHash = 'hFYxZCY6UjXOANHRUCjGVlPrEJZw6Tdt1hf1CbYXE4M=';
export const hostHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hostScriptHash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light;color:#2C2416;font-family:system-ui,-apple-system,sans-serif}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;user-select:none}
#stream-surface{width:100%;min-height:100%;padding:6px 0 10px;display:flex;flex-direction:column;justify-content:space-between;gap:10px;transform-origin:top center}
#stream-surface > *{flex-shrink:0}
#stream-surface > :only-child:not(svg){flex:1 0 auto;min-height:0!important}
#stream-surface > svg{width:100%;height:auto;max-height:calc(100vh - 16px);display:block}
svg text.t{font-size:15px;fill:#2C2416}svg text.ts{font-size:13px;fill:#6B5D4D}svg text.th{font-size:16px;font-weight:600;fill:#2C2416}
[data-prompt],[data-voice-prompt],svg g[id],svg g[aria-label]{cursor:pointer}
.canvas-tap-flash{filter:drop-shadow(0 0 8px rgba(200,109,45,.55)) brightness(.96)!important}
</style><style id="extra-stream-styles"></style></head>
<body><div id="stream-surface"></div><script>${hostScript}</script></body></html>`;
