/* listen.dayjoy.in - live translated audio, and the archive of past trainings. */

const $ = (id) => document.getElementById(id);

const state = {
  channels: [],
  lang: localStorage.getItem('dayjoy.lang') || null,
  ws: null,
  reconnectMs: 1000,
  pendingHeader: null,
  ctx: null,
  gain: null,
  playing: false,
  nextAt: 0,
  scheduled: new Set(),
  bytes: 0,
  segments: 0,
  listeningSince: null,
  status: { live: false },
  showOriginal: localStorage.getItem('dayjoy.showOriginal') === 'true',
};

// ---------------------------------------------------------------- helpers

const fmtMB = (b) => `${(b / 1048576).toFixed(1)} MB`;

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function fmtWhen(iso) {
  const d = new Date(iso);
  return d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ------------------------------------------------------------ audio engine

/**
 * Segments are scheduled strictly back to back rather than at the times they
 * arrived. That is the silence-compression half of drift control: the gaps
 * where the trainer paused are where the channel quietly catches up.
 */
function audioContext() {
  if (!state.ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    state.ctx = new Ctx();
    state.gain = state.ctx.createGain();
    state.gain.connect(state.ctx.destination);
  }
  return state.ctx;
}

/** Resuming only ever happens from a tap, never as a side effect of a segment
 *  arriving - otherwise the next sentence quietly un-pauses the listener. */
async function startPlayback() {
  const ctx = audioContext();
  await ctx.resume();
  state.playing = true;
  state.nextAt = ctx.currentTime;
}

async function pausePlayback() {
  state.playing = false;
  stopAllAudio();
  await state.ctx?.suspend();
}

function stopAllAudio() {
  for (const src of state.scheduled) {
    try {
      src.stop();
    } catch {
      /* already finished */
    }
  }
  state.scheduled.clear();
  state.nextAt = state.ctx ? state.ctx.currentTime : 0;
}

async function playSegment(arrayBuffer, header) {
  // Captions keep flowing while paused - they are the fallback when someone
  // cannot use audio at all.
  if (!state.playing) {
    addCaption(header);
    return;
  }

  const ctx = audioContext();
  let buffer;
  try {
    buffer = await ctx.decodeAudioData(arrayBuffer);
  } catch {
    addCaption(header, { undecodable: true });
    return;
  }

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(state.gain);

  const startAt = Math.max(ctx.currentTime + 0.08, state.nextAt);
  src.start(startAt);
  state.nextAt = startAt + buffer.duration;
  state.scheduled.add(src);
  src.onended = () => state.scheduled.delete(src);

  // Show the caption as the sentence is actually spoken, not when it arrived.
  const delayMs = Math.max(0, (startAt - ctx.currentTime) * 1000);
  setTimeout(() => addCaption(header), delayMs);
}

// -------------------------------------------------------------- captions

function addCaption(header, opts = {}) {
  const box = $('captions');
  const placeholder = box.querySelector('.muted');
  if (placeholder) placeholder.remove();

  for (const el of box.querySelectorAll('.cap.now')) el.classList.remove('now');

  const div = document.createElement('div');
  div.className = 'cap now' + (header.flagged ? ' flagged' : '');

  const text = document.createElement('span');
  text.textContent = header.text || '';
  div.appendChild(text);

  if (header.sourceText) {
    const src = document.createElement('span');
    src.className = 'src';
    src.textContent = header.sourceText;
    div.appendChild(src);
  }

  if (header.type === 'caption-only') {
    const w = document.createElement('span');
    w.className = 'warn';
    // The reason has to match what actually happened. Telling someone a figure
    // failed when the real cause was an unapproved claim sends them chasing the
    // wrong thing.
    w.textContent =
      header.reason === 'claim-not-approved'
        ? 'This part is not translated. Please listen to the trainer for it.'
        : 'Held back from audio - a figure in this sentence did not translate cleanly. Please check with the trainer.';
    div.appendChild(w);
  } else if (header.type === 'skipped') {
    text.textContent = '(one sentence skipped so the audio could catch up)';
    div.className = 'cap flagged';
  } else if (opts.undecodable) {
    const w = document.createElement('span');
    w.className = 'warn';
    w.textContent = 'This sentence could not be played on this device.';
    div.appendChild(w);
  }

  box.appendChild(div);
  while (box.children.length > 40) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

// ---------------------------------------------------------------- meters

function updateMeters() {
  $('mData').textContent = fmtMB(state.bytes);

  const mins = state.listeningSince ? (Date.now() - state.listeningSince) / 60000 : 0;
  const perHour = mins > 0.5 ? (state.bytes / 1048576 / mins) * 60 : 0;
  $('mRate').textContent = `${perHour.toFixed(0)} MB/hr`;

  const ahead = state.ctx ? Math.max(0, state.nextAt - state.ctx.currentTime) : 0;
  const bufEl = $('mBuffer');
  bufEl.textContent = `${ahead.toFixed(1)} s`;
  bufEl.className = 'v' + (ahead > 12 ? ' bad' : ahead > 6 ? ' warn' : '');

  $('mSegs').textContent = String(state.segments);
}

setInterval(updateMeters, 500);

// ------------------------------------------------------------- language UI

function renderLanguages() {
  const grid = $('langGrid');
  grid.innerHTML = '';

  for (const ch of state.channels) {
    const btn = document.createElement('button');
    btn.className = 'langbtn';
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(state.lang === ch.code));

    const native = document.createElement('span');
    native.className = 'native';
    native.textContent = ch.native;
    native.lang = ch.code;

    const latin = document.createElement('span');
    latin.className = 'latin';

    if (ch.mode === 'original') {
      // The trainer's own voice is not re-broadcast here; it is already in the
      // Zoom room, and streaming raw microphone audio would cost listeners far
      // more data than the translated channels do.
      btn.disabled = true;
      latin.textContent = 'Original - listen on Zoom';
    } else {
      latin.textContent = state.lang === ch.code ? `${ch.name} - playing` : ch.name;
      btn.addEventListener('click', () => selectLanguage(ch.code));
    }

    btn.append(native, latin);
    grid.appendChild(btn);
  }

  const chosen = state.channels.find((c) => c.code === state.lang && c.mode !== 'original');
  const btn = $('startBtn');
  if (!chosen) {
    btn.disabled = true;
    btn.textContent = 'Choose a language first';
  } else if (!state.playing) {
    btn.disabled = false;
    btn.textContent = `Tap to listen in ${chosen.name}`;
  } else {
    btn.disabled = false;
    btn.textContent = `Listening in ${chosen.name} - tap to stop`;
  }
}

function selectLanguage(code) {
  state.lang = code;
  localStorage.setItem('dayjoy.lang', code);
  stopAllAudio();
  state.bytes = 0;
  state.segments = 0;
  state.listeningSince = Date.now();
  $('captions').innerHTML = '';
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify({ type: 'subscribe', lang: code }));
  renderLanguages();
  updateMeters();
}

let toggling = false;

$('startBtn').addEventListener('click', async () => {
  if (toggling) return; // a double-tap must not land as pause-then-play
  toggling = true;
  try {
    if (state.playing) {
      await pausePlayback();
      $('playHint').textContent = 'Paused. Captions keep updating. Tap again to resume.';
    } else {
      await startPlayback();
      state.listeningSince = state.listeningSince || Date.now();
      $('playHint').textContent = state.status.live
        ? 'Connected. Audio starts with the trainer’s next sentence.'
        : 'Ready. Audio starts as soon as the training goes live.';
    }
    renderLanguages();
  } finally {
    toggling = false;
  }
});

// ------------------------------------------------------------- ask a question

function renderAskState() {
  const chosen = state.channels.find((c) => c.code === state.lang && c.mode !== 'original');
  const ready = Boolean(chosen) && state.status.live;
  $('askSend').disabled = !ready;
  $('askSend').textContent = state.status.live ? 'Send question' : 'Wait for the training to start';
  if (!chosen && state.status.live) $('askNote').textContent = 'Choose your language first.';
}

$('askSend').addEventListener('click', () => {
  const text = $('askText').value.trim();
  if (!text) {
    $('askNote').textContent = 'Please type a question first.';
    return;
  }
  if (state.ws?.readyState !== 1) {
    $('askNote').textContent = 'Not connected. Please wait a moment and try again.';
    return;
  }
  const name = $('askName').value.trim();
  localStorage.setItem('dayjoy.askName', name);
  state.lastAsked = text;
  state.ws.send(JSON.stringify({ type: 'question', text, askedBy: name }));
  $('askSend').disabled = true;
  $('askNote').textContent = 'Sending…';
});

function questionSent(text) {
  $('askText').value = '';
  $('askNote').textContent = 'Sent. The trainer will answer it out loud during the training.';
  $('askSend').disabled = false;

  // A sent question that vanishes looks like it failed, so keep a local copy.
  const row = document.createElement('div');
  row.className = 'row';
  row.style.cursor = 'default';
  const t = document.createElement('span');
  t.className = 'title';
  t.textContent = text;
  t.style.fontWeight = '400';
  t.style.fontSize = '.9rem';
  const s = document.createElement('span');
  s.className = 'sub';
  s.textContent = 'Sent to the trainer';
  row.append(t, s);
  $('askSent').prepend(row);
}

// ------------------------------------------------------------------ status

function applyStatus(s) {
  state.status = s;
  const badge = $('liveBadge');
  if (s.live) {
    badge.className = 'badge live';
    badge.textContent = 'Live now';
    $('sessionTitle').textContent = s.title || 'Dayjoy Product Training';
    $('sessionMeta').textContent = `${s.listeners} listening · ${fmtClock(s.elapsedMs)} elapsed`;
  } else {
    badge.className = 'badge';
    badge.textContent = 'Offline';
    $('sessionTitle').textContent = 'No training running right now';
    $('sessionMeta').textContent = 'Choose your language below - the page will start playing on its own when the training begins.';
  }
  renderAskState();
}

// -------------------------------------------------------------- websocket

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws/listen${state.lang ? `?lang=${state.lang}` : ''}`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.onopen = () => {
    state.reconnectMs = 1000;
    if (state.lang) ws.send(JSON.stringify({ type: 'subscribe', lang: state.lang }));
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') {
      const header = state.pendingHeader;
      state.pendingHeader = null;
      if (!header) return;
      state.bytes += ev.data.byteLength;
      state.segments += 1;
      playSegment(ev.data, header);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.type === 'status') applyStatus(msg);
    else if (msg.type === 'segment') state.pendingHeader = msg;
    else if (msg.type === 'caption-only' || msg.type === 'skipped') addCaption(msg);
    else if (msg.type === 'question-sent') questionSent(state.lastAsked || '');
    else if (msg.type === 'question-error') {
      $('askNote').textContent = msg.error;
      $('askSend').disabled = false;
    }
  };

  ws.onclose = () => {
    setTimeout(connect, state.reconnectMs);
    state.reconnectMs = Math.min(15000, state.reconnectMs * 1.7);
  };

  ws.onerror = () => ws.close();
}

// ------------------------------------------------------------- recordings

let recordings = [];

async function loadRecordings() {
  try {
    const res = await fetch('/api/recordings');
    const data = await res.json();
    recordings = data.recordings || [];
  } catch {
    recordings = [];
  }
  renderRecordingList();
}

function renderRecordingList() {
  const host = $('recList');
  host.innerHTML = '';

  if (!recordings.length) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<p class="muted">No trainings have been recorded yet. Every live session is archived automatically in each language it was delivered in.</p>';
    host.appendChild(card);
    return;
  }

  const rows = document.createElement('div');
  rows.className = 'rows';

  for (const rec of recordings) {
    const row = document.createElement('button');
    row.className = 'row';
    row.type = 'button';

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = rec.title;

    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.innerHTML = `<span>${fmtWhen(rec.startedAt)}</span><span>${fmtClock(rec.durationMs)}</span>`;

    const chips = document.createElement('span');
    chips.className = 'chips';
    for (const c of rec.channels) {
      if (!c.durationMs) continue;
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = c.native;
      chip.lang = c.code;
      chips.appendChild(chip);
    }

    row.append(title, sub, chips);
    row.addEventListener('click', () => openRecording(rec.id));
    rows.appendChild(row);
  }

  host.appendChild(rows);
}

let currentManifest = null;
let currentRecLang = null;

async function openRecording(id) {
  const res = await fetch(`/api/recordings/${id}`);
  if (!res.ok) return;
  currentManifest = await res.json();

  $('recList').classList.add('hidden');
  $('recDetail').classList.remove('hidden');
  $('recTitle').textContent = currentManifest.title;
  $('recMeta').textContent = `${fmtWhen(currentManifest.startedAt)} · ${fmtClock(currentManifest.durationMs)}`;

  const available = Object.values(currentManifest.channels).filter((c) => c.file && c.durationMs > 0);
  const preferred = available.find((c) => c.code === state.lang) || available[0];
  renderRecLanguages(available);
  if (preferred) selectRecLanguage(preferred.code);
}

function renderRecLanguages(available) {
  const grid = $('recLangGrid');
  grid.innerHTML = '';

  if (!available.length) {
    grid.innerHTML = '<p class="muted">No audio was archived for this session.</p>';
    return;
  }

  for (const ch of available) {
    const btn = document.createElement('button');
    btn.className = 'langbtn';
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(currentRecLang === ch.code));

    const native = document.createElement('span');
    native.className = 'native';
    native.textContent = ch.native;
    native.lang = ch.code;

    const latin = document.createElement('span');
    latin.className = 'latin';
    latin.textContent = ch.mode === 'original' ? `${ch.name} - trainer's voice` : ch.name;

    btn.append(native, latin);
    btn.addEventListener('click', () => selectRecLanguage(ch.code));
    grid.appendChild(btn);
  }
}

function selectRecLanguage(code) {
  currentRecLang = code;
  const ch = currentManifest.channels[code];
  const audio = $('recAudio');
  const wasPlaying = !audio.paused;

  audio.src = `/api/recordings/${currentManifest.id}/audio/${ch.file}`;
  audio.load();
  if (wasPlaying) audio.play().catch(() => {});

  $('recAudioNote').textContent =
    ch.mode === 'original'
      ? 'The trainer’s original recording, exactly as delivered.'
      : `${ch.segmentCount} sentences · ${fmtMB(ch.bytes)} · AI translated${ch.flaggedCount ? ` · ${ch.flaggedCount} flagged for review` : ''}`;

  renderRecLanguages(Object.values(currentManifest.channels).filter((c) => c.file && c.durationMs > 0));
  renderTranscript(ch);
}

function renderTranscript(ch) {
  const host = $('recTranscript');
  host.innerHTML = '';

  if (!ch.segments?.length) {
    host.innerHTML = '<p class="muted">No transcript was captured for this channel.</p>';
    return;
  }

  for (const seg of ch.segments) {
    const line = document.createElement('button');
    line.className = 'tline';
    line.type = 'button';
    line.dataset.at = String(seg.atMs);
    line.dataset.until = String(seg.atMs + seg.durationMs);

    const t = document.createElement('span');
    t.className = 't';
    t.textContent = fmtClock(seg.atMs);

    const text = document.createElement('span');
    text.textContent = seg.text;
    if (seg.flagged) text.style.color = 'var(--amber)';

    line.append(t, text);
    line.addEventListener('click', () => {
      $('recAudio').currentTime = seg.atMs / 1000;
      $('recAudio').play().catch(() => {});
    });
    host.appendChild(line);
  }
}

$('recAudio').addEventListener('timeupdate', (e) => {
  const ms = e.target.currentTime * 1000;
  for (const line of $('recTranscript').children) {
    if (!line.dataset) continue;
    const active = ms >= Number(line.dataset.at) && ms < Number(line.dataset.until);
    if (active) {
      if (line.getAttribute('aria-current') !== 'true') {
        line.setAttribute('aria-current', 'true');
        line.scrollIntoView({ block: 'nearest' });
      }
    } else {
      line.removeAttribute('aria-current');
    }
  }
});

$('backBtn').addEventListener('click', () => {
  $('recAudio').pause();
  $('recDetail').classList.add('hidden');
  $('recList').classList.remove('hidden');
});

// ------------------------------------------------------------------- tabs

function showTab(which) {
  const live = which === 'live';
  $('tabLive').setAttribute('aria-selected', String(live));
  $('tabRec').setAttribute('aria-selected', String(!live));
  $('paneLive').classList.toggle('hidden', !live);
  $('paneRec').classList.toggle('hidden', live);
  if (!live) loadRecordings();
}

$('tabLive').addEventListener('click', () => showTab('live'));
$('tabRec').addEventListener('click', () => showTab('rec'));

// ------------------------------------------------------------------- boot

// Captions carry the trainer's Hinglish under the translation. A Telugu
// listener does not need it, and on a phone it halves how much they can see.
function applyShowOriginal() {
  document.body.classList.toggle('hide-original', !state.showOriginal);
  const btn = $('origToggle');
  if (btn) {
    btn.setAttribute('aria-pressed', String(state.showOriginal));
    btn.textContent = state.showOriginal ? 'Hide original' : 'Show original';
  }
}

$('origToggle')?.addEventListener('click', () => {
  state.showOriginal = !state.showOriginal;
  localStorage.setItem('dayjoy.showOriginal', String(state.showOriginal));
  applyShowOriginal();
});

$('shareBtn')?.addEventListener('click', async () => {
  const url = state.status.id ? `${location.origin}/s/${state.status.id}` : location.origin;
  try {
    if (navigator.share) await navigator.share({ title: state.status.title || 'Dayjoy Training', url });
    else await navigator.clipboard.writeText(url);
    $('shareNote').textContent = navigator.share ? '' : 'Link copied.';
  } catch {
    $('shareNote').textContent = url;
  }
});

(async function boot() {
  applyShowOriginal();

  try {
    const cfg = await (await fetch('/api/config')).json();
    state.channels = cfg.channels || [];
  } catch {
    state.channels = [];
  }
  renderLanguages();

  try {
    applyStatus(await (await fetch('/api/status')).json());
  } catch {
    /* the websocket will deliver status shortly */
  }

  connect();

  // A /s/<id> link is the same link whether the training is running or finished.
  const deep = /^\/s\/([\w-]+)$/.exec(location.pathname);
  if (deep) {
    const id = deep[1];
    if (state.status.live && state.status.id === id) {
      showTab('live');
    } else {
      showTab('rec');
      await loadRecordings();
      await openRecording(id).catch(() => {});
    }
  }
})();
