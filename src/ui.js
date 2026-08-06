function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderHomePage(query = "") {
  const safeQuery = escapeHtml(query.slice(0, 200));

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>书库</title>
  <link rel="stylesheet" href="/__z/assets/app.css">
</head>
<body>
  <header class="app-bar">
    <a class="brand" href="/">书库</a>
    <nav aria-label="账户导航">
      <a href="/login">源站账户</a>
    </nav>
  </header>
  <main class="app-main" data-query="${safeQuery}">
    <section class="search-area" aria-labelledby="search-title">
      <h1 id="search-title">查找书籍</h1>
      <form class="search-form" role="search">
        <label class="sr-only" for="book-query">书名、作者或 ISBN</label>
        <input id="book-query" name="q" value="${safeQuery}" maxlength="200" autocomplete="off" placeholder="书名、作者或 ISBN" required>
        <button type="submit">搜索</button>
      </form>
      <div class="scope-switch" aria-label="搜索范围">
        <button type="button" aria-pressed="true">开放资源</button>
        <a id="source-search" href="/">授权书库</a>
      </div>
    </section>
    <section class="results-area" aria-live="polite" hidden>
      <div class="results-head">
        <h2>开放资源</h2>
        <p id="result-status"></p>
      </div>
      <div id="source-status" class="source-status"></div>
      <ol id="book-results" class="book-list"></ol>
    </section>
  </main>
  <script src="/__z/assets/app.js" defer></script>
</body>
</html>`;
}

export const APP_CSS = String.raw`
:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #202522;
  background: #f4f6f3;
  font-synthesis: none;
}

* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; background: #f4f6f3; }
a { color: inherit; }
button, input { font: inherit; letter-spacing: 0; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

.app-bar {
  height: 58px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 max(20px, calc((100vw - 1040px) / 2));
  background: #ffffff;
  border-bottom: 1px solid #dfe4df;
}
.brand { font-size: 18px; font-weight: 750; text-decoration: none; color: #172019; }
.app-bar nav a { font-size: 14px; color: #49524d; text-decoration: none; }
.app-bar nav a:hover { color: #11653b; }

.app-main { width: min(100% - 32px, 960px); margin: 0 auto; padding: 64px 0 80px; }
.search-area { width: min(100%, 720px); margin: 0 auto; }
.search-area h1 { margin: 0 0 20px; font-size: 40px; line-height: 1.12; letter-spacing: 0; text-align: center; }
.search-form { display: grid; grid-template-columns: 1fr auto; height: 52px; background: #ffffff; border: 1px solid #aeb8b1; border-radius: 8px; overflow: hidden; box-shadow: 0 8px 26px rgba(36, 49, 40, 0.08); }
.search-form:focus-within { border-color: #177245; box-shadow: 0 0 0 3px rgba(23, 114, 69, 0.14); }
.search-form input { min-width: 0; padding: 0 16px; border: 0; outline: 0; color: #202522; background: transparent; }
.search-form input::placeholder { color: #7c8580; }
.search-form button { min-width: 88px; padding: 0 20px; border: 0; color: #ffffff; background: #176b42; cursor: pointer; font-weight: 700; }
.search-form button:hover { background: #0f5935; }
.search-form button:disabled { opacity: 0.62; cursor: wait; }

.scope-switch { display: flex; justify-content: center; gap: 2px; width: fit-content; margin: 14px auto 0; padding: 3px; background: #e5e9e5; border-radius: 7px; }
.scope-switch button, .scope-switch a { min-height: 32px; padding: 7px 13px; border: 0; border-radius: 5px; font-size: 13px; line-height: 18px; text-decoration: none; cursor: pointer; }
.scope-switch button { color: #1d5f3c; background: #ffffff; box-shadow: 0 1px 2px rgba(26, 37, 30, 0.1); font-weight: 700; }
.scope-switch a { color: #4c5650; background: transparent; }
.scope-switch a:hover { color: #172019; background: #f1f3f1; }

.results-area { margin-top: 52px; }
.results-head { display: flex; align-items: baseline; justify-content: space-between; gap: 20px; padding-bottom: 12px; border-bottom: 1px solid #d9ded9; }
.results-head h2 { margin: 0; font-size: 18px; letter-spacing: 0; }
.results-head p { margin: 0; color: #69726d; font-size: 13px; }
.source-status { display: flex; gap: 8px; min-height: 26px; padding: 12px 0 6px; color: #5e6762; font-size: 12px; }
.source-status span { padding-right: 9px; border-right: 1px solid #ccd2cd; }
.source-status span:last-child { border-right: 0; }

.book-list { margin: 0; padding: 0; list-style: none; }
.book-row { display: grid; grid-template-columns: 72px minmax(0, 1fr) auto; gap: 16px; min-height: 126px; padding: 16px 0; border-bottom: 1px solid #d9ded9; }
.book-cover { width: 72px; height: 104px; object-fit: cover; background: #dde2dd; border: 1px solid #ced4cf; border-radius: 4px; }
.book-cover-placeholder { display: grid; place-items: center; color: #7b847e; font-size: 11px; text-align: center; }
.book-info { min-width: 0; padding-top: 2px; }
.book-info h3 { margin: 0 0 6px; font-size: 16px; line-height: 1.35; letter-spacing: 0; overflow-wrap: anywhere; }
.book-info h3 a { text-decoration: none; }
.book-info h3 a:hover { color: #11653b; text-decoration: underline; }
.book-meta { margin: 0 0 9px; color: #626b66; font-size: 13px; line-height: 1.45; }
.book-tags { display: flex; flex-wrap: wrap; gap: 7px; color: #59625d; font-size: 11px; }
.book-tags span { padding-right: 7px; border-right: 1px solid #c6ccc7; }
.book-tags span:last-child { border-right: 0; }
.book-actions { display: flex; align-items: flex-start; justify-content: flex-end; flex-wrap: wrap; gap: 7px; max-width: 210px; padding-top: 2px; }
.book-actions a { min-height: 34px; padding: 7px 11px; border: 1px solid #aab3ad; border-radius: 6px; background: #ffffff; color: #26302a; font-size: 12px; font-weight: 700; text-decoration: none; }
.book-actions a.primary { color: #ffffff; border-color: #176b42; background: #176b42; }
.book-actions a:hover { border-color: #176b42; }
.empty-state { padding: 54px 16px; color: #69726d; text-align: center; }

@media (max-width: 680px) {
  .app-bar { padding: 0 16px; }
  .app-main { width: min(100% - 24px, 960px); padding-top: 42px; }
  .search-area h1 { font-size: 28px; }
  .search-form { height: 48px; }
  .search-form button { min-width: 72px; padding: 0 14px; }
  .results-area { margin-top: 40px; }
  .book-row { grid-template-columns: 62px minmax(0, 1fr); gap: 12px; }
  .book-cover { width: 62px; height: 90px; }
  .book-actions { grid-column: 2; justify-content: flex-start; max-width: none; margin-top: -2px; }
}
`;

export const APP_JS = String.raw`
(function () {
  var main = document.querySelector('.app-main');
  var form = document.querySelector('.search-form');
  var input = document.querySelector('#book-query');
  var sourceLink = document.querySelector('#source-search');
  var resultsArea = document.querySelector('.results-area');
  var resultList = document.querySelector('#book-results');
  var resultStatus = document.querySelector('#result-status');
  var sourceStatus = document.querySelector('#source-status');
  var submitButton = form.querySelector('button[type="submit"]');

  function sourceSearchUrl(query) {
    return '/s/' + encodeURIComponent(query.trim());
  }

  function setSourceLink(query) {
    sourceLink.href = query.trim() ? sourceSearchUrl(query) : '/';
  }

  function safeUrl(value) {
    try {
      var url = new URL(value);
      return url.protocol === 'https:' ? url.toString() : null;
    } catch (_) {
      return null;
    }
  }

  function textElement(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    return element;
  }

  function actionLink(label, href, primary) {
    var link = document.createElement('a');
    link.textContent = label;
    link.href = safeUrl(href) || '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    if (primary) link.className = 'primary';
    return link;
  }

  function renderBook(book) {
    var row = document.createElement('li');
    row.className = 'book-row';

    var coverUrl = safeUrl(book.cover);
    var cover;
    if (coverUrl) {
      cover = document.createElement('img');
      cover.className = 'book-cover';
      cover.src = coverUrl;
      cover.alt = '';
      cover.loading = 'lazy';
      cover.referrerPolicy = 'no-referrer';
    } else {
      cover = textElement('div', 'book-cover book-cover-placeholder', '暂无封面');
    }

    var info = document.createElement('div');
    info.className = 'book-info';
    var heading = document.createElement('h3');
    var titleLink = actionLink(book.title, book.details, false);
    heading.appendChild(titleLink);
    info.appendChild(heading);
    info.appendChild(textElement('p', 'book-meta', (book.authors || []).join('、') || '作者未知'));

    var tags = document.createElement('div');
    tags.className = 'book-tags';
    tags.appendChild(textElement('span', '', book.sourceLabel));
    tags.appendChild(textElement('span', '', book.rightsLabel));
    if (book.year) tags.appendChild(textElement('span', '', String(book.year)));
    if (book.languages && book.languages.length) {
      tags.appendChild(textElement('span', '', book.languages.join(' / ').toUpperCase()));
    }
    info.appendChild(tags);

    var actions = document.createElement('div');
    actions.className = 'book-actions';
    (book.downloads || []).slice(0, 3).forEach(function (download, index) {
      actions.appendChild(actionLink(download.label, download.href, index === 0));
    });
    if (!book.downloads || !book.downloads.length) {
      actions.appendChild(actionLink('阅读', book.details, true));
    } else {
      actions.appendChild(actionLink('详情', book.details, false));
    }

    row.appendChild(cover);
    row.appendChild(info);
    row.appendChild(actions);
    return row;
  }

  function renderSourceStatus(sources) {
    sourceStatus.replaceChildren();
    var entries = [
      ['Project Gutenberg', sources.gutenberg],
      ['Open Library', sources.openlibrary]
    ];
    entries.forEach(function (entry) {
      var status = entry[1].ok ? entry[1].count + ' 项' : '暂不可用';
      sourceStatus.appendChild(textElement('span', '', entry[0] + ' ' + status));
    });
  }

  async function search(query) {
    var trimmed = query.trim();
    if (!trimmed) return;

    setSourceLink(trimmed);
    history.replaceState(null, '', '/?q=' + encodeURIComponent(trimmed));
    resultsArea.hidden = false;
    resultList.replaceChildren();
    resultStatus.textContent = '搜索中';
    sourceStatus.replaceChildren();
    submitButton.disabled = true;

    try {
      var response = await fetch('/__z/api/search?q=' + encodeURIComponent(trimmed), {
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error('Search failed');
      var payload = await response.json();
      renderSourceStatus(payload.sources);
      resultStatus.textContent = payload.results.length + ' 项结果';

      if (!payload.results.length) {
        resultList.appendChild(textElement('li', 'empty-state', '没有找到可公开阅读的结果'));
        return;
      }
      payload.results.forEach(function (book) {
        resultList.appendChild(renderBook(book));
      });
    } catch (_) {
      resultStatus.textContent = '搜索暂不可用';
      resultList.appendChild(textElement('li', 'empty-state', '开放资源服务暂时不可用'));
    } finally {
      submitButton.disabled = false;
    }
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    search(input.value);
  });
  input.addEventListener('input', function () { setSourceLink(input.value); });

  var initialQuery = main.dataset.query || '';
  setSourceLink(initialQuery);
  if (initialQuery) search(initialQuery);
})();
`;

export const PATCH_CSS = String.raw`
.zp-toolbar { position: sticky; top: 0; z-index: 2147483000; min-height: 56px; display: grid; grid-template-columns: auto minmax(180px, 620px) auto; align-items: center; gap: 18px; padding: 8px max(16px, calc((100vw - 1040px) / 2)); background: #ffffff; border-bottom: 1px solid #dce2dd; color: #202522; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
.zp-toolbar a { color: #26302a; text-decoration: none; }
.zp-toolbar .zp-brand { font-size: 17px; font-weight: 750; }
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
        speed.textContent = gateway.ok ? gateway.latencyMs + ' ms · ' + gateway.kibPerSecond + ' KiB/s' : '不可用';
        row.appendChild(label);
        row.appendChild(speed);
        if (gateway.ok) {
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
        }
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

export function renderSourceToolbar(query) {
  return `<header class="zp-toolbar">
  <a class="zp-brand" href="/">书库</a>
  <form class="zp-search-form" data-zp-source-search role="search">
    <input value="${escapeHtml(query.slice(0, 200))}" maxlength="200" aria-label="搜索授权书库" placeholder="书名、作者或 ISBN" required>
    <button type="submit">搜索</button>
  </form>
  <a class="zp-account" href="/login">源站账户</a>
</header>`;
}
