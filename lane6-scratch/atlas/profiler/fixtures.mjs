// atlas profiler — standing fixture family, page-side builders (no network but
// localhost asset URLs). Shapes replicate experiments-EXP-v3-share-local/bench-exp.mjs
// (400-card share-safe / neutral-unsafe / non-neutral) and extend with light + asset-heavy.
export const FIXTURE_OPTIONS = { scale: 1, dpr: 1, embedFonts: false, cache: 'disabled' };

export const PAGE_FIXTURE_SRC = String.raw`
window.__fx = (() => {
  const ID = 'v3-probe';
  const BASE = '[data-v3-audit="' + ID + '"]{--accent:rgb(37,99,235);width:900px;box-sizing:border-box;padding:12px;background:white;color:#222;font:13px/1.35 Arial,sans-serif}'
    + '[data-v3-audit="' + ID + '"] .grid{display:grid;grid-template-columns:repeat(8,1fr);gap:5px}'
    + '[data-v3-audit="' + ID + '"] .card{min-width:0;padding:5px 6px;border:1px solid #d8dee9;border-radius:4px;background:#f8fafc}'
    + '[data-v3-audit="' + ID + '"] .label{color:#475569}'
    + '[data-v3-audit="' + ID + '"] .value{color:var(--accent);font-weight:700}'
    + '[data-v3-audit="' + ID + '"] .value::before{content:"#";color:#94a3b8;margin-right:1px}';
  const GATES = {
    'cards400-safe': '',
    'cards400-neutral-unsafe': '[data-v3-audit="' + ID + '"] .card:nth-child(3n){outline-offset:0px}',
    'cards400-non-neutral': '[data-v3-audit="' + ID + '"] .card:nth-child(3n){background-color:#eef4ff}'
      + '[data-v3-audit="' + ID + '"] .card:nth-child(5n){border-color:var(--accent)}',
  };
  function cardMarkup(count) {
    let html = '<div class="grid">';
    for (let i = 0; i < count; i++) {
      html += '<div class="card"><span class="label">metric ' + String(i).padStart(4, '0') + ': </span><span class="value" data-metric="' + i + '">' + String(1000 + i).padStart(4, '0') + '</span></div>';
    }
    return html + '</div>';
  }
  function buildCards(name, count) {
    const style = document.createElement('style');
    style.id = 'v3-probe-style';
    style.textContent = BASE + (GATES[name] || '');
    document.head.appendChild(style);
    const root = document.createElement('div');
    root.dataset.v3Audit = ID;
    root.innerHTML = cardMarkup(count);
    document.body.appendChild(root);
    return root;
  }
  const ASSET_CSS = '[data-v3-audit="' + ID + '"].asset-root{width:900px;padding:10px;background:#fff;font:13px/1.35 Arial,sans-serif}'
    + '[data-v3-audit="' + ID + '"] .asset-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px}'
    + '[data-v3-audit="' + ID + '"] .asset-card{position:relative;padding:6px;border:1px solid #cbd5e1;border-radius:6px;background-image:url("/img/b.png");background-size:24px 12px}'
    + '[data-v3-audit="' + ID + '"] .asset-card::before{content:"@";position:absolute;top:2px;right:4px;color:#fff;background-image:url("/img/a.png");background-size:auto;padding:0 3px}'
    + '[data-v3-audit="' + ID + '"] .asset-card img{display:block;width:60px;height:24px;object-fit:cover}'
    + '@font-face{font-family:AtlasProbe;src:url("/font/probe.ttf") format("truetype");font-display:swap}'
    + '[data-v3-audit="' + ID + '"] .fonty{font-family:AtlasProbe,Arial,sans-serif;font-size:12px}';
  function buildAsset(count) {
    const style = document.createElement('style');
    style.id = 'v3-probe-style';
    style.textContent = ASSET_CSS;
    document.head.appendChild(style);
    const root = document.createElement('div');
    root.dataset.v3Audit = ID;
    root.className = 'asset-root';
    let html = '<svg width="0" height="0" style="position:absolute"><defs>'
      + '<symbol id="ic" viewBox="0 0 16 16"><path d="M2 2h12v12H2z" fill="#60a5fa"/><circle cx="8" cy="8" r="3" fill="#1d4ed8"/></symbol>'
      + '<linearGradient id="lg"><stop offset="0" stop-color="#93c5fd"/><stop offset="1" stop-color="#1e40af"/></linearGradient></defs></svg>'
      + '<div class="asset-grid">';
    for (let i = 0; i < count; i++) {
      html += '<div class="asset-card"><img src="/img/a.png" alt="a' + i + '">'
        + '<p class="fonty">asset ' + i + ' text</p>'
        + '<svg width="20" height="20"><use href="#ic"/></svg>'
        + '<span style="fill:url(#lg);background-image:url(/img/b.png)">s' + i + '</span></div>';
    }
    html += '</div>';
    root.innerHTML = html;
    document.body.appendChild(root);
    return root;
  }
  const COUNTS = { 'light-20cards': 20, 'cards400-safe': 400, 'cards400-neutral-unsafe': 400, 'cards400-non-neutral': 400, 'asset-heavy': 60 };
  window.__fx = {
    build(name) {
      if (name === 'asset-heavy') return buildAsset(COUNTS[name]);
      return buildCards(name, COUNTS[name]);
    },
    cleanup(el) { try { el.remove(); } catch {} const s = document.getElementById('v3-probe-style'); if (s) s.remove(); },
    ID,
  };
  return window.__fx;
})();
window.__fxReady = true;
`;
