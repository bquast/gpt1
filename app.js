// Nostr Wiki (NIP-54) – tiny reader
// reads kind:30818, optional #d filter; basic [[wikilinks]] support
// spec reference: https://nips.nostr.com/54

const qs = (sel) => document.querySelector(sel);
const articlesEl = qs('#articles');
const viewer = qs('#viewer');
const viewerTitle = qs('#viewer-title');

let ws = null;
let currentRelay = null;
let subIdCounter = 0;

// --- helpers ---------------------------------------------------------------

function normalizeDTag(input) {
  if (!input) return '';
  return input
    .toLowerCase()
    .replace(/[^a-z]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function escapeHtml(s) {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// very small renderer: paragraphs + wikilinks + nostr: links + http(s)
function renderContent(asciitxt) {
  const safe = escapeHtml(asciitxt);

  // wikilinks: [[Target]] or [[target page|see this]]
  const withWiki = safe.replace(/\[\[([^\]\|]+?)(?:\|([^\]]+))?\]\]/g, (_m, target, label) => {
    const d = normalizeDTag(target);
    const text = label ? escapeHtml(label) : escapeHtml(target.trim());
    return `<a href="#" data-wiki="${d}" class="wikilink">${text}</a>`;
  });

  // nostr:... (turn into plain links)
  const withNostr = withWiki.replace(/(nostr:[\w\d:+-]+)/g, `<a href="$1" target="_blank" rel="noopener">$1</a>`);

  // http(s) links
  const withHttp = withNostr.replace(/(https?:\/\/[^\s<]+)(?![^<]*>)/g, `<a href="$1" target="_blank" rel="noopener">$1</a>`);

  // basic paragraphs
  return withHttp.split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');
}

function connect(relayURL) {
  if (ws) {
    try { ws.close(1000, 'reconnect'); } catch {}
    ws = null;
  }
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(relayURL);
    sock.onopen = () => { ws = sock; currentRelay = relayURL; resolve(); };
    sock.onerror = (e) => reject(e);
    sock.onclose = () => {};
  });
}

function subscribe(filters, onEvent, onEose) {
  if (!ws || ws.readyState !== 1) throw new Error('websocket not open');
  const subId = `sub-${Date.now()}-${++subIdCounter}`;
  const msg = ['REQ', subId, ...filters];
  ws.send(JSON.stringify(msg));
  ws.addEventListener('message', function handler(ev) {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    const [type, id, payload] = data;
    if (type === 'EVENT' && id === subId) {
      onEvent(payload);
    }
    if (type === 'EOSE' && id === subId) {
      onEose?.();
      ws.removeEventListener('message', handler);
    }
  });
  return () => ws?.send(JSON.stringify(['CLOSE', subId]));
}

function formatTs(ts) {
  try {
    return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
  } catch { return String(ts); }
}

function tagValue(tags, name) {
  const t = tags.find(t => t[0] === name);
  return t ? t[1] : null;
}

// --- UI + query flows ------------------------------------------------------

async function fetchLatest() {
  const relay = qs('#relay').value.trim();
  const limit = Math.max(1, Math.min(100, Number(qs('#limit').value) || 10));
  await ensureConnected(relay);

  const items = [];
  const close = subscribe(
    [{ kinds: [30818], limit }],
    (ev) => items.push(ev),
    () => {
      renderList(items.sort((a, b) => b.created_at - a.created_at));
      close();
    }
  );
}

async function fetchByTopic() {
  const relay = qs('#relay').value.trim();
  const topicInput = qs('#topic').value.trim();
  const limit = Math.max(1, Math.min(100, Number(qs('#limit').value) || 10));
  const d = normalizeDTag(topicInput);
  if (!d) {
    alert('please enter a topic');
    return;
  }
  await ensureConnected(relay);

  const items = [];
  const close = subscribe(
    [{ kinds: [30818], '#d': [d], limit }],
    (ev) => items.push(ev),
    () => {
      renderList(items.sort((a, b) => b.created_at - a.created_at));
      if (items.length) showArticle(items[0]); else viewer.innerHTML = `<p class="muted">no articles for <code>${d}</code> found.</p>`;
      close();
    }
  );
}

async function ensureConnected(relayURL) {
  if (!ws || ws.readyState !== 1 || currentRelay !== relayURL) {
    qs('#articles').innerHTML = '';
    viewer.innerHTML = '<p class="muted">connecting…</p>';
    await connect(relayURL);
  }
}

function renderList(events) {
  articlesEl.innerHTML = '';
  if (!events.length) {
    articlesEl.innerHTML = `<li class="muted" style="padding:10px">no results.</li>`;
    return;
  }
  for (const ev of events) {
    const d = tagValue(ev.tags, 'd') || '';
    const title = tagValue(ev.tags, 'title') || (d || '(untitled)');
    const summary = tagValue(ev.tags, 'summary') || '';
    const li = document.createElement('li');
    li.innerHTML = `
      <div>
        <div class="item-title">${escapeHtml(title)}</div>
        <div class="item-sub">${summary ? escapeHtml(summary) : `<span class="muted">id ${ev.id.slice(0, 8)}…</span>`}</div>
      </div>
      <span class="badge">${d || 'no-d'}</span>
    `;
    li.addEventListener('click', () => showArticle(ev));
    articlesEl.appendChild(li);
  }
}

function showArticle(ev) {
  const d = tagValue(ev.tags, 'd') || '';
  const title = tagValue(ev.tags, 'title') || (d || '(untitled)');
  viewerTitle.textContent = title;
  viewer.innerHTML = renderContent(ev.content || '');

  // enable wikilinks click-through
  viewer.querySelectorAll('a.wikilink').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const target = a.getAttribute('data-wiki');
      qs('#topic').value = target;
      fetchByTopic().catch(err => alert(`error: ${err.message}`));
    });
  });
}

// --- wire up ---------------------------------------------------------------

qs('#btn-latest').addEventListener('click', () => {
  fetchLatest().catch(err => alert(`error: ${err.message}`));
});

qs('#btn-topic').addEventListener('click', () => {
  fetchByTopic().catch(err => alert(`error: ${err.message}`));
});

// auto-connect and fetch latest on load (non-blocking)
fetchLatest().catch(() => {
  viewer.innerHTML = '<p class="muted">unable to connect to relay. set a different relay url and try again.</p>';
});