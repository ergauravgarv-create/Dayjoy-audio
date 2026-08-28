/* Trainer console - captures the microphone and drives the live session. */

const $ = (id) => document.getElementById(id);

const TARGET_RATE = 16000;

const state = {
  ws: null,
  ctx: null,
  node: null,
  stream: null,
  capturing: false,
  live: false,
  stats: null,
};

function key() {
  const fromUrl = new URL(location.href).searchParams.get('key');
  if (fromUrl) {
    localStorage.setItem('dayjoy.trainerKey', fromUrl);
    return fromUrl;
  }
  return localStorage.getItem('dayjoy.trainerKey') || 'dayjoy-trainer';
}

// ------------------------------------------------------------- mic capture

/**
 * The worklet only forwards raw frames. Resampling and 16-bit conversion happen
 * on the main thread, because the recogniser wants 16 kHz mono PCM and browsers
 * do not all honour a requested AudioContext sample rate.
 */
const WORKLET_SOURCE = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.count = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      this.buf.push(new Float32Array(ch));
      this.count += ch.length;
      if (this.count >= 2048) {
        const out = new Float32Array(this.count);
        let o = 0;
        for (const b of this.buf) { out.set(b, o); o += b.length; }
        this.port.postMessage(out, [out.buffer]);
        this.buf = []; this.count = 0;
      }
    }
    return true;
  }
}
registerProcessor('dayjoy-tap', Tap);
`;

function downsample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const low = Math.floor(pos);
    const high = Math.min(low + 1, input.length - 1);
    const frac = pos - low;
    out[i] = input[low] * (1 - frac) + input[high] * frac;
  }
  return out;
}

function toInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

async function listMics() {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    $('levelNote').textContent = 'Microphone permission denied.';
    return;
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const select = $('micSelect');
  select.innerHTML = '';
  for (const d of devices.filter((d) => d.kind === 'audioinput')) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || 'Microphone';
    select.appendChild(opt);
  }
}

async function startCapture() {
  if (state.capturing) return;

  const Ctx = window.AudioContext || window.webkitAudioContext;
  state.ctx = new Ctx({ sampleRate: TARGET_RATE });
  await state.ctx.resume();

  const deviceId = $('micSelect').value;
  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const source = state.ctx.createMediaStreamSource(state.stream);

  const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  await state.ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  state.node = new AudioWorkletNode(state.ctx, 'dayjoy-tap');

  state.node.port.onmessage = (ev) => {
    const frames = ev.data;

    let peak = 0;
    for (let i = 0; i < frames.length; i += 8) peak = Math.max(peak, Math.abs(frames[i]));
    $('levelBar').style.width = `${Math.min(100, peak * 160).toFixed(0)}%`;

    if (state.ws?.readyState === 1) {
      const resampled = downsample(frames, state.ctx.sampleRate, TARGET_RATE);
      state.ws.send(toInt16(resampled).buffer);
    }
  };

  source.connect(state.node);

  // Keep the graph alive without echoing the trainer back to themselves.
  const mute = state.ctx.createGain();
  mute.gain.value = 0;
  state.node.connect(mute).connect(state.ctx.destination);

  state.capturing = true;
  $('levelNote').textContent = `Capturing at ${state.ctx.sampleRate} Hz`;
}

async function stopCapture() {
  state.capturing = false;
  try {
    state.node?.disconnect();
    state.stream?.getTracks().forEach((t) => t.stop());
    await state.ctx?.close();
  } catch {
    /* already torn down */
  }
  state.node = null;
  state.stream = null;
  state.ctx = null;
  $('levelBar').style.width = '0%';
  $('levelNote').textContent = 'Not capturing';
}

// -------------------------------------------------------------- websocket

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/trainer?key=${encodeURIComponent(key())}`);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.type === 'status') applyStatus(msg);
    else if (msg.type === 'stats') applyStats(msg.stats);
    else if (msg.type === 'source' && msg.kind === 'phrase') addSource(msg.text);
    else if (msg.type === 'incident') addIncident(msg.incident);
    else if (msg.type === 'aligned') setAlignLabel(msg.ms);
    else if (msg.type === 'question') {
      // Sent twice: once immediately in the original, again once translated.
      state.questions.set(msg.question.id, msg.question);
      renderQuestions();
    }
    else if (msg.type === 'ended') {
      addIncident({ kind: 'saved', detail: `Recording saved as ${msg.id}`, at: new Date().toISOString() });
    } else if (msg.type === 'error') {
      addIncident({ kind: 'error', detail: msg.detail, at: new Date().toISOString() });
    }
  };

  ws.onclose = () => setTimeout(connect, 1500);
  ws.onerror = () => ws.close();
}

// The trainer console also polls, so channel figures keep updating even when
// the session is quiet and no events are flowing.
setInterval(async () => {
  try {
    const s = await (await fetch('/api/status')).json();
    applyStatus(s);
  } catch {
    /* transient */
  }
}, 3000);

// ------------------------------------------------------------------- views

function applyStatus(s) {
  state.live = s.live;
  const badge = $('liveBadge');
  badge.className = s.live ? 'badge live' : 'badge';
  badge.textContent = s.live ? `Live · ${s.listeners} listening` : 'Offline';
  $('goLive').disabled = s.live;
  $('endSession').disabled = !s.live;
  $('goLive').textContent = s.live ? 'Training is live' : 'Start training';
  if (s.listenerCounts) state.listenerCounts = s.listenerCounts;
  if (s.audioIn) applyAudioIn(s.audioIn);
}

function applyAudioIn(a) {
  const stateEl = $('aiState');
  stateEl.textContent = a.receiving ? 'Yes' : 'No';
  stateEl.className = 'v' + (a.receiving ? '' : ' bad');

  const rateEl = $('aiRate');
  rateEl.textContent = a.kbPerSecond.toFixed(1);
  // Well under the expected rate means frames are being dropped between the
  // browser and the server, which shows up later as clipped words.
  const shortfall = a.expectedKbPerSecond ? a.kbPerSecond / a.expectedKbPerSecond : 1;
  rateEl.className = 'v' + (!a.receiving ? '' : shortfall < 0.8 ? ' bad' : shortfall < 0.95 ? ' warn' : '');

  const levelEl = $('aiLevel');
  levelEl.textContent = a.level.toFixed(3);
  levelEl.className = 'v' + (a.receiving && a.level < 0.005 ? ' warn' : '');

  $('aiSeconds').textContent = `${a.seconds.toFixed(0)}s`;

  if (!a.receiving) {
    $('aiNote').textContent = a.bytes
      ? 'Not currently sending audio. Figures above are from the last capture.'
      : 'If "Reaching server" stays red while the level bar moves, the microphone is working but the connection is not - nothing downstream will run.';
  } else if (a.level < 0.005) {
    $('aiNote').textContent = 'Audio is reaching the server but it is almost silent - check you picked the right microphone and are not muted.';
  } else if (shortfall < 0.8) {
    $('aiNote').textContent = 'Frames are being dropped between the browser and the server. Words will arrive clipped.';
  } else {
    $('aiNote').textContent = 'Microphone is reaching the server cleanly.';
  }
}

function applyStats(stats) {
  state.stats = stats;
  if (stats?.listenerCounts) state.listenerCounts = stats.listenerCounts;
  const body = $('channelTable').querySelector('tbody');
  body.innerHTML = '';

  for (const ch of stats?.pipeline?.channels || []) {
    const tr = document.createElement('tr');
    const behind = (ch.backlogMs / 1000).toFixed(1);
    const behindColor = ch.backlogMs > 8000 ? 'var(--red)' : ch.backlogMs > 4000 ? 'var(--amber)' : 'var(--ink)';
    tr.innerHTML =
      `<td>${ch.native} <span class="muted">${ch.name}</span></td>` +
      `<td class="num">${state.listenerCounts?.[ch.code] ?? 0}</td>` +
      `<td class="num">${ch.segments}</td>` +
      `<td class="num" style="color:${behindColor}">${behind}s</td>` +
      `<td class="num">${ch.rate.toFixed(2)}x</td>` +
      `<td class="num">${ch.flagged}</td>` +
      `<td class="num">${ch.droppedSegments}</td>`;
    body.appendChild(tr);
  }
}

function addSource(text) {
  const box = $('sourceFeed');
  const placeholder = box.querySelector('.muted');
  if (placeholder) placeholder.remove();
  for (const el of box.querySelectorAll('.cap.now')) el.classList.remove('now');
  const div = document.createElement('div');
  div.className = 'cap now';
  div.textContent = text;
  box.appendChild(div);
  while (box.children.length > 25) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
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
  title.textContent =
    incident.kind === 'segment-withheld'
      ? `Not spoken in ${incident.lang.toUpperCase()} - please repeat this figure`
      : incident.kind === 'claim-not-approved'
        ? `Not spoken in ${incident.lang.toUpperCase()} - this claim is not approved. Please make the point in your own words.`
        : incident.kind === 'source-claim-risk'
          ? 'Careful - that was claim language'
          : incident.kind === 'saved'
            ? 'Recording saved'
            : incident.kind;
  if (incident.kind === 'claim-not-approved') title.style.color = 'var(--orange)';
  if (incident.kind === 'source-claim-risk') title.style.color = 'var(--red)';

  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = incident.sourceText || incident.detail || (incident.issues || []).map((i) => i.detail).join(' · ');

  row.append(title, sub);
  box.prepend(row);
  while (box.children.length > 20) box.removeChild(box.lastChild);
}

// ---------------------------------------------------------------- questions

state.questions = new Map();
state.showAnswered = false;

function renderQuestions() {
  const box = $('questions');
  const all = [...state.questions.values()].sort((a, b) => new Date(b.at) - new Date(a.at));
  const shown = state.showAnswered ? all : all.filter((q) => !q.answered);
  const pending = all.filter((q) => !q.answered).length;

  const badge = $('qCount');
  badge.textContent = pending ? `${pending} waiting` : all.length ? 'All answered' : 'None yet';
  badge.className = pending ? 'badge warn' : 'badge ok';

  box.innerHTML = '';
  if (!shown.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = all.length
      ? 'Every question has been answered.'
      : 'Distributors type questions in their own language. They appear here translated, for you to answer out loud.';
    box.appendChild(p);
    return;
  }

  for (const q of shown) {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.cursor = 'default';
    if (q.answered) row.style.opacity = '.55';

    // The translation is what the trainer reads aloud, so it leads. The original
    // sits underneath because seeing their own words matters to the asker when
    // the trainer repeats the question.
    const main = document.createElement('span');
    main.className = 'title';
    main.textContent = q.hi || q.en || q.original;
    main.style.fontSize = '1.02rem';

    const sub = document.createElement('span');
    sub.className = 'sub';
    const who = q.askedBy ? `${q.askedBy} · ` : '';
    sub.textContent = `${who}${q.langName}${q.hi && q.en ? '' : q.via === 'none' ? ' · not translated' : ''}`;

    row.append(main, sub);

    if (q.en && q.hi) {
      const en = document.createElement('span');
      en.className = 'sub';
      en.textContent = q.en;
      en.style.color = 'var(--ink-2)';
      row.appendChild(en);
    }

    const orig = document.createElement('span');
    orig.className = 'sub';
    orig.textContent = q.original;
    orig.lang = q.lang;
    orig.style.color = 'var(--ink-3)';
    row.appendChild(orig);

    const btn = document.createElement('button');
    btn.className = 'btn ghost';
    btn.style.cssText = 'padding:5px 11px;font-size:.8rem;align-self:flex-start;margin-top:4px';
    btn.textContent = q.answered ? 'Mark unanswered' : 'Answered';
    btn.addEventListener('click', () => {
      state.ws?.send(JSON.stringify({ type: 'answered', id: q.id, answered: !q.answered }));
    });
    row.appendChild(btn);

    box.appendChild(row);
  }
}

$('qToggleAnswered').addEventListener('click', () => {
  state.showAnswered = !state.showAnswered;
  $('qToggleAnswered').setAttribute('aria-pressed', String(state.showAnswered));
  $('qToggleAnswered').textContent = state.showAnswered ? 'Hide answered' : 'Show answered';
  renderQuestions();
});

function setAlignLabel(ms) {
  $('alignValue').textContent = `Hold translated audio back by ${(ms / 1000).toFixed(1)} s`;
}

// ----------------------------------------------------------------- actions

$('goLive').addEventListener('click', async () => {
  try {
    await startCapture();
  } catch (err) {
    // Cancelling Chrome's share picker is a normal thing to do, not a fault.
    const cancelled = err.name === 'NotAllowedError' || err.name === 'AbortError';
    $('levelNote').textContent = cancelled ? 'Capture cancelled.' : err.message;
    if (!cancelled) addIncident({ kind: 'error', detail: err.message, at: '' });
    return;
  }
  state.ws?.send(JSON.stringify({ type: 'start', title: $('titleInput').value }));
});

$('endSession').addEventListener('click', async () => {
  state.ws?.send(JSON.stringify({ type: 'stop' }));
  await stopCapture();
});

$('alignRange').addEventListener('input', (e) => {
  const ms = Number(e.target.value);
  setAlignLabel(ms);
  state.ws?.send(JSON.stringify({ type: 'align', ms }));
});

$('micSelect').addEventListener('change', async () => {
  if (state.capturing) {
    await stopCapture();
    await startCapture();
  }
});

window.addEventListener('beforeunload', () => {
  if (state.live) navigator.sendBeacon?.('/api/status');
});

listMics();
connect();
setAlignLabel(0);
