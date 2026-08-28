/* Admin console - is this session actually meeting the acceptance bar? */

const $ = (id) => document.getElementById(id);

// Published list prices, used only to show an order of magnitude live.
const PRICE = {
  asrPerHour: 1.0,
  ttsPerMillionChars: 15.0,
  mtPerMillionCharsIn: 1.0,
  bandwidthPerGB: 0.12,
};

function key() {
  const fromUrl = new URL(location.href).searchParams.get('key');
  if (fromUrl) {
    localStorage.setItem('dayjoy.adminKey', fromUrl);
    return fromUrl;
  }
  return localStorage.getItem('dayjoy.adminKey') || 'dayjoy-admin';
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/admin?key=${encodeURIComponent(key())}`);

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'stats') render(msg.stats);
    else if (msg.type === 'incident') addIncident(msg.incident);
  };

  ws.onclose = () => setTimeout(connect, 2000);
  ws.onerror = () => ws.close();
}

function grade(el, value, good, warn, format) {
  el.textContent = value === null || value === undefined ? '-' : format(value);
  el.className = 'v' + (value === null ? '' : value <= good ? '' : value <= warn ? ' warn' : ' bad');
}

function render(stats) {
  const badge = $('liveBadge');
  badge.className = stats.live ? 'badge live' : 'badge';
  badge.textContent = stats.live ? `Live · ${stats.title}` : 'Offline';

  const pipeline = stats.pipeline;
  const channels = pipeline?.channels || [];

  // Sub-second delays are real and worth seeing; rounding them to "0.0s" hides
  // the difference between a fast pipeline and one that is not running at all.
  const fmtDelay = (v) => (v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(1)}s`);
  grade($('mMedian'), pipeline?.latency?.medianMs ?? null, 5000, 8000, fmtDelay);
  grade($('mP95'), pipeline?.latency?.p95Ms ?? null, 8000, 12000, fmtDelay);

  const worstDrift = channels.length ? Math.max(...channels.map((c) => c.maxBacklogMs)) : null;
  grade($('mDrift'), worstDrift, 2000, 6000, (v) => `${(v / 1000).toFixed(1)}s`);

  $('mListeners').textContent = String(stats.listeners ?? 0);

  const flagged = channels.reduce((a, c) => a + c.flagged, 0);
  const withheld = channels.reduce((a, c) => a + c.fallbacks, 0);
  $('mFlagged').textContent = String(flagged);
  const wEl = $('mWithheld');
  wEl.textContent = String(withheld);
  wEl.className = 'v' + (withheld > 0 ? ' bad' : '');

  const body = $('chTable').querySelector('tbody');
  body.innerHTML = '';
  for (const ch of channels) {
    const behindColor = ch.backlogMs > 8000 ? 'var(--red)' : ch.backlogMs > 4000 ? 'var(--amber)' : 'var(--ink)';
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${ch.native} <span class="muted">${ch.name}</span></td>` +
      `<td class="num">${stats.listenerCounts?.[ch.code] ?? 0}</td>` +
      `<td class="num">${(ch.spokenMs / 60000).toFixed(1)}m</td>` +
      `<td class="num" style="color:${behindColor}">${(ch.backlogMs / 1000).toFixed(1)}s</td>` +
      `<td class="num">${(ch.maxBacklogMs / 1000).toFixed(1)}s</td>` +
      `<td class="num">${ch.rate.toFixed(2)}x</td>` +
      `<td class="num">${ch.retries}</td>` +
      `<td class="num">${ch.flagged}</td>` +
      `<td class="num">${ch.droppedSegments}</td>` +
      `<td class="num">${ch.failures}</td>`;
    body.appendChild(tr);
  }

  renderCost(stats);
  renderGlossary(stats.glossary);
}

function renderCost(stats) {
  const hours = (stats.elapsedMs || 0) / 3600000;
  const charsOut = stats.pipeline?.totals?.charsOut || 0;
  const charsIn = stats.pipeline?.totals?.charsIn || 0;

  const asr = hours * PRICE.asrPerHour;
  const tts = (charsOut / 1e6) * PRICE.ttsPerMillionChars;
  const mt = (charsIn / 1e6) * PRICE.mtPerMillionCharsIn;

  // 32 kbps of audio per listener, only while they are actually listening.
  const gb = ((stats.listeners || 0) * hours * 3600 * 4000) / 1073741824;
  const bandwidth = gb * PRICE.bandwidthPerGB;

  const rows = [
    ['Recognition', asr],
    ['Translation', mt],
    ['Neural voice', tts],
    ['Bandwidth', bandwidth],
    ['Total', asr + mt + tts + bandwidth],
  ];

  const body = $('costTable').querySelector('tbody');
  body.innerHTML = '';
  rows.forEach(([label, value], i) => {
    const tr = document.createElement('tr');
    if (i === rows.length - 1) tr.style.fontWeight = '700';
    tr.innerHTML = `<td>${label}</td><td class="num">$${value.toFixed(3)}</td>`;
    body.appendChild(tr);
  });
}

function renderGlossary(g) {
  if (!g) return;
  $('glossaryLine').textContent = g.unreviewed.length
    ? `Version ${g.version} · ${g.unreviewed.length} entries awaiting native-speaker review`
    : `Version ${g.version} · every entry reviewed`;

  const chips = $('unreviewedChips');
  chips.innerHTML = '';
  for (const term of g.unreviewed.slice(0, 24)) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = term;
    chips.appendChild(chip);
  }
}

function addIncident(incident) {
  const box = $('incidents');
  const placeholder = box.querySelector('.muted');
  if (placeholder) placeholder.remove();

  const row = document.createElement('div');
  row.className = 'row';
  row.style.cursor = 'default';

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = `${incident.kind}${incident.lang ? ` · ${incident.lang}` : ''}`;
  if (incident.kind === 'segment-withheld') title.style.color = 'var(--red)';

  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent =
    incident.detail || incident.sourceText || (incident.issues || []).map((i) => i.detail).join(' · ');

  row.append(title, sub);
  box.prepend(row);
  while (box.children.length > 40) box.removeChild(box.lastChild);
}

connect();
