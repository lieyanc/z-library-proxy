// The home page frontend is a React + shadcn/ui app built from frontend/.
// Its bundles are embedded by scripts/generate-assets.mjs into this module.
import { APP_CSS, APP_JS, ASSETS_VERSION } from "./assets.generated.js";

export { APP_CSS, APP_JS };

// Applies the persisted theme before the React bundle loads to avoid a flash
// of the wrong color scheme. Keep byte-for-byte in sync with frontend/index.html
// and with THEME_INIT_SCRIPT_SHA256 below (verified by test/proxy.test.js).
export const THEME_INIT_SCRIPT =
  "(function(){try{var t=localStorage.getItem('zlp-theme')||'system';var d=t==='dark'||t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d)}catch(e){}})();";

export const THEME_INIT_SCRIPT_SHA256 = "+f4cXEXLdjyENhulfE+rzbQ4mpIrJlAopGekQf+BDyE=";

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderHomePage(query = "", upstreamHost = "") {
  const safeQuery = escapeHtml(query.slice(0, 200));
  const safeUpstreamHost = escapeHtml(upstreamHost);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>书库</title>
  <link rel="stylesheet" href="/__z/assets/app.css?v=${ASSETS_VERSION}">
  <script>${THEME_INIT_SCRIPT}</script>
</head>
<body>
  <div id="root" data-query="${safeQuery}" data-upstream="${safeUpstreamHost}"></div>
  <script type="module" src="/__z/assets/app.js?v=${ASSETS_VERSION}"></script>
</body>
</html>`;
}

export const PATCH_CSS = String.raw`
.zp-toolbar { position: sticky; top: 0; z-index: 2147483000; min-height: 56px; display: grid; grid-template-columns: auto minmax(180px, 620px) auto; align-items: center; gap: 18px; padding: 8px max(16px, calc((100vw - 1040px) / 2)); background: #ffffff; border-bottom: 1px solid #dce2dd; color: #202522; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
.zp-toolbar a { color: #26302a; text-decoration: none; }
.zp-toolbar .zp-brand { display: inline-flex; align-items: center; gap: 8px; font-size: 17px; font-weight: 750; }
.zp-toolbar .zp-brand svg { width: 18px; height: 18px; flex: none; fill: currentColor; }
.zp-toolbar .zp-tools { display: flex; align-items: center; gap: 14px; }
.zp-toolbar .zp-home { display: inline-flex; align-items: center; color: #26302a; }
.zp-toolbar .zp-home svg { width: 18px; height: 18px; }
.zp-toolbar .zp-account { font-size: 13px; color: #56615a; }
.zp-search-form { height: 38px; display: grid; grid-template-columns: 1fr auto; overflow: hidden; border: 1px solid #aeb8b1; border-radius: 7px; background: #ffffff; }
.zp-search-form:focus-within { border-color: #176b42; box-shadow: 0 0 0 3px rgba(23, 107, 66, 0.12); }
.zp-search-form input { min-width: 0; padding: 0 12px; border: 0; outline: 0; background: transparent; color: #202522; font: inherit; letter-spacing: 0; }
.zp-search-form button { min-width: 68px; border: 0; color: #ffffff; background: #176b42; font: 700 13px/1 Inter, ui-sans-serif, system-ui, sans-serif; letter-spacing: 0; cursor: pointer; }

body.zp-search-page { display: block !important; min-height: 100% !important; margin: 0 !important; background: #f4f6f3 !important; color: #202522; }
body.zp-search-page > header:not(.zp-toolbar), body.zp-search-page > footer, body.zp-search-page .footer, body.zp-search-page ins.adsbygoogle, body.zp-search-page [class*="advert" i], body.zp-search-page [id^="ad-"] { display: none !important; }
body.zp-search-page > main, body.zp-search-page > .container, body.zp-search-page .container.main, body.zp-search-page #searchResultBox { width: min(100% - 24px, 1040px) !important; max-width: 1040px !important; margin-inline: auto !important; }
body.zp-search-page .resItemBox, body.zp-search-page .bookRow, body.zp-search-page [class*="book-card" i], body.zp-search-page [class*="bookCard"] { border: 0 !important; border-bottom: 1px solid #d8ded9 !important; border-radius: 0 !important; background: transparent !important; box-shadow: none !important; }
body.zp-search-page img { max-width: 100%; }

.zp-ipfs-button { min-height: 32px; margin-left: 8px; padding: 6px 10px; border: 1px solid #8ea397; border-radius: 6px; color: #145d3a; background: #f7faf8; font: 700 12px/1.2 Inter, ui-sans-serif, system-ui, sans-serif; letter-spacing: 0; cursor: pointer; vertical-align: middle; }
.zp-ipfs-button:hover { border-color: #176b42; background: #edf5f0; }
.zp-ipfs-dialog { width: min(92vw, 560px); padding: 0; border: 1px solid #cbd3cd; border-radius: 8px; color: #202522; background: #ffffff; box-shadow: 0 24px 70px rgba(22, 34, 26, 0.2); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
.zp-ipfs-dialog::backdrop { background: rgba(21, 28, 23, 0.42); }
.zp-ipfs-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 18px; border-bottom: 1px solid #dde3de; }
.zp-ipfs-head strong { font-size: 15px; }
.zp-ipfs-close { width: 32px; height: 32px; padding: 0; border: 0; color: #4c5650; background: transparent; font-size: 22px; cursor: pointer; }
.zp-ipfs-body { min-height: 120px; padding: 10px 18px 18px; }
.zp-ipfs-cid { margin: 6px 0 12px; color: #68726c; font: 11px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
.zp-gateway-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 12px; min-height: 54px; border-bottom: 1px solid #e3e7e4; font-size: 13px; }
.zp-gateway-actions { display: flex; align-items: center; gap: 6px; }
.zp-gateway-actions a { padding: 7px 10px; border: 1px solid #176b42; border-radius: 6px; color: #ffffff; background: #176b42; text-decoration: none; font-weight: 700; white-space: nowrap; }
.zp-gateway-actions a.zp-direct-link { color: #31513f; border-color: #aab8af; background: #ffffff; }
.zp-gateway-row .zp-speed { color: #5f6963; font-size: 11px; }
.zp-ipfs-note { margin: 14px 0 0; color: #727b76; font-size: 11px; }

@media (max-width: 680px) {
  .zp-toolbar { grid-template-columns: auto 1fr; gap: 10px; padding: 8px 12px; }
  .zp-toolbar .zp-brand span { display: none; }
  .zp-toolbar .zp-account { display: none; }
  .zp-search-form button { min-width: 58px; }
  .zp-gateway-row { grid-template-columns: minmax(0, 1fr) auto; }
  .zp-gateway-row .zp-speed { grid-column: 1; }
}
`;

export const PATCH_JS = String.raw`
(function () {
  var sourceForm = document.querySelector('[data-zp-source-search]');
  if (sourceForm) {
    sourceForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var input = sourceForm.querySelector('input');
      var query = input.value.trim();
      if (query) location.href = '/s/' + encodeURIComponent(query);
    });
  }

  var cidV0 = 'Qm[1-9A-HJ-NP-Za-km-z]{44}';
  var cidV1 = 'b[a-z2-7]{20,120}';
  var cidPattern = new RegExp('(?:ipfs:\\/\\/|\\/ipfs\\/)(' + cidV0 + '|' + cidV1 + ')(\\/[^?#]*)?', 'i');

  function ipfsDetailsFromElement(element) {
    var explicitCid = element.getAttribute('data-cid');
    if (explicitCid && new RegExp('^(' + cidV0 + '|' + cidV1 + ')$').test(explicitCid)) {
      return {
        cid: explicitCid,
        path: element.getAttribute('data-ipfs-path') || '',
        filename: element.getAttribute('download') || ''
      };
    }
    var href = element.getAttribute('href') || '';
    if (!href.includes('ipfs://') && !href.includes('/ipfs/')) return null;
    var match = href.match(cidPattern);
    if (!match) return null;
    var path = (match[2] || '').replace(/^\/+/, '');
    try { path = decodeURIComponent(path); } catch (_) {}
    var filename = element.getAttribute('download') || '';
    if (!filename && path) filename = path.split('/').pop();
    return { cid: match[1], path: path, filename: filename };
  }

  function ensureDialog() {
    var dialog = document.querySelector('.zp-ipfs-dialog');
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.className = 'zp-ipfs-dialog';
    dialog.innerHTML = '<div class="zp-ipfs-head"><strong>IPFS 下载</strong><button class="zp-ipfs-close" type="button" aria-label="关闭">×</button></div><div class="zp-ipfs-body"></div>';
    dialog.querySelector('.zp-ipfs-close').addEventListener('click', function () { dialog.close(); });
    dialog.addEventListener('click', function (event) { if (event.target === dialog) dialog.close(); });
    document.body.appendChild(dialog);
    return dialog;
  }

  function addText(parent, className, text) {
    var node = document.createElement('p');
    node.className = className;
    node.textContent = text;
    parent.appendChild(node);
  }

  async function showGateways(details) {
    var dialog = ensureDialog();
    var body = dialog.querySelector('.zp-ipfs-body');
    body.replaceChildren();
    addText(body, 'zp-ipfs-cid', details.cid + (details.path ? '/' + details.path : ''));
    addText(body, '', '正在测试 64 KiB 样本');
    if (!dialog.open) dialog.showModal();

    try {
      var params = new URLSearchParams({ cid: details.cid });
      if (details.path) params.set('path', details.path);
      if (details.filename) params.set('filename', details.filename);
      var response = await fetch('/__z/api/ipfs-probe?' + params.toString(), { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('Probe failed');
      var payload = await response.json();
      body.replaceChildren();
      addText(body, 'zp-ipfs-cid', details.cid + (details.path ? '/' + details.path : ''));
      payload.gateways.forEach(function (gateway) {
        var row = document.createElement('div');
        row.className = 'zp-gateway-row';
        var label = document.createElement('strong');
        label.textContent = gateway.label;
        var speed = document.createElement('span');
        speed.className = 'zp-speed';
        speed.textContent = gateway.ok ? gateway.latencyMs + ' ms · ' + gateway.kibPerSecond + ' KiB/s' : '测速超时';
        row.appendChild(label);
        row.appendChild(speed);
        var actions = document.createElement('div');
        actions.className = 'zp-gateway-actions';
        if (gateway.proxyUrl) {
          var proxyDownload = document.createElement('a');
          proxyDownload.href = gateway.proxyUrl;
          proxyDownload.textContent = '代理下载';
          actions.appendChild(proxyDownload);
        }
        var directDownload = document.createElement('a');
        directDownload.className = gateway.proxyUrl ? 'zp-direct-link' : '';
        directDownload.href = gateway.url;
        directDownload.target = '_blank';
        directDownload.rel = 'noopener noreferrer';
        directDownload.textContent = gateway.proxyUrl ? '直连' : '打开';
        actions.appendChild(directDownload);
        row.appendChild(actions);
        body.appendChild(row);
      });
      addText(
        body,
        'zp-ipfs-note',
        payload.proxyAllowed
          ? '代理下载会经当前 Worker 流式传输'
          : '此 CID 未加入 Worker 授权列表，仅提供网关直连'
      );
    } catch (_) {
      body.replaceChildren();
      addText(body, 'zp-ipfs-cid', details.cid);
      addText(body, '', '网关测速暂不可用');
    }
  }

  var ipfsSelector = 'a[href*="/ipfs/"], a[href^="ipfs://"], [data-cid]';

  function enhanceElement(element) {
    var details = ipfsDetailsFromElement(element);
    if (!details || element.dataset.zpIpfsEnhanced) return;
    element.dataset.zpIpfsEnhanced = 'true';
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'zp-ipfs-button';
    button.textContent = 'IPFS 下载';
    button.addEventListener('click', function () { showGateways(details); });
    element.insertAdjacentElement('afterend', button);
  }

  function enhanceTree(root) {
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    if (root.matches(ipfsSelector)) enhanceElement(root);
    root.querySelectorAll(ipfsSelector).forEach(enhanceElement);
  }

  enhanceTree(document.body);
  new MutationObserver(function (mutations) {
    mutations.forEach(function (mutation) {
      mutation.addedNodes.forEach(enhanceTree);
    });
  }).observe(document.body, { childList: true, subtree: true });
})();
`;

const GITHUB_REPO_URL = "https://github.com/lieyanc/z-library-proxy";

const GITHUB_ICON_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>';

const SEARCH_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';

export function renderSourceToolbar(query, upstreamHost) {
  return `<header class="zp-toolbar">
  <a class="zp-brand" href="${GITHUB_REPO_URL}" target="_blank" rel="noopener noreferrer">${GITHUB_ICON_SVG}<span>lieyanc/z-library-proxy</span></a>
  <form class="zp-search-form" data-zp-source-search role="search">
    <input value="${escapeHtml(query.slice(0, 200))}" maxlength="200" aria-label="搜索 Z-Library" placeholder="书名、作者或 ISBN" required>
    <button type="submit">搜索</button>
  </form>
  <div class="zp-tools">
    <a class="zp-home" href="/" aria-label="搜索主页" title="搜索主页">${SEARCH_ICON_SVG}</a>
    <a class="zp-account" href="/login">${escapeHtml(upstreamHost)}账户</a>
  </div>
</header>`;
}
