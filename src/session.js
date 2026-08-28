import { randomUUID } from 'node:crypto';
import { Pipeline } from './pipeline.js';
import { SessionRecorder } from './recorder.js';
import { QuestionBoard, createQuestionTranslator } from './questions.js';
import { logger } from './log.js';

const log = logger('session');

function sessionId(startedAt) {
  const d = new Date(startedAt);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${stamp}-${randomUUID().slice(0, 6)}`;
}

/**
 * One live training. Owns the pipeline, the listener sockets, and the archive
 * being written to disk as the session runs.
 */
export class LiveSession {
  constructor({ config, providers, glossary }) {
    this.config = config;
    this.providers = providers;
    this.glossary = glossary;

    this.id = null;
    this.title = 'Dayjoy Product Training';
    this.startedAt = null;
    this.live = false;

    this.listeners = new Set(); // { ws, lang, joinedAt, bytes }
    this.consoles = new Set(); // trainer + admin sockets
    this.pipeline = null;
    this.recorder = null;
    this.incidents = [];

    // Everything downstream is worthless if the microphone is not actually
    // arriving, and a silent channel looks identical to a broken one. These
    // counters are what tell a trainer "your mic is live" before they start.
    this.audioIn = { bytes: 0, chunks: 0, firstAt: 0, lastAt: 0, peak: 0, rms: 0, silentChunks: 0 };

    // Distributors type questions; the trainer reads and answers them aloud.
    // The spoken answer goes out through the normal pipeline, so everyone hears
    // it in their own language without anyone needing a microphone.
    this.questions = new QuestionBoard({
      translator: createQuestionTranslator(config, providers),
      onQuestion: (q) => this.#toConsoles({ type: 'question', question: q }),
    });
  }

  async askQuestion({ ws, text, askedBy }) {
    const entry = ws._dayjoy;
    const channel = this.config.channels.find((c) => c.code === entry?.lang);
    if (!channel) throw new Error('Choose your language first.');
    if (!this.live) throw new Error('The training is not running right now.');
    return this.questions.submit({ text, channel, askedBy, key: entry });
  }

  /** Byte rate, level and silence, computed from the PCM the trainer is sending. */
  audioInStats() {
    const a = this.audioIn;
    const now = Date.now();
    // Measured to the last packet, not to now. Using now would make the rate
    // sag every time the trainer pauses, and a trainer reading 20 kB/s against
    // an expected 31 would reasonably conclude frames were being dropped.
    const elapsed = a.firstAt ? (a.lastAt - a.firstAt) / 1000 : 0;
    return {
      receiving: a.lastAt > 0 && now - a.lastAt < 2000,
      bytes: a.bytes,
      kbPerSecond: elapsed > 0.5 ? +(a.bytes / 1024 / elapsed).toFixed(1) : 0,
      // 16 kHz, 16-bit mono is 32 kB/s. A materially lower rate means frames
      // are being dropped somewhere between the browser and here.
      expectedKbPerSecond: +((this.config.audio.inputSampleRate * 2) / 1024).toFixed(1),
      seconds: +elapsed.toFixed(1),
      level: +a.rms.toFixed(4),
      peak: +a.peak.toFixed(4),
      silentChunks: a.silentChunks,
    };
  }

  listenerCounts() {
    const counts = {};
    for (const c of this.config.channels) counts[c.code] = 0;
    for (const l of this.listeners) if (l.lang) counts[l.lang] = (counts[l.lang] || 0) + 1;
    return counts;
  }

  /** A channel is worth producing if someone is on it, or if config forces it. */
  isChannelActive(code) {
    if (this.config.translateAllChannels) return true;
    if (this.config.alwaysOnLangs.includes(code)) return true;
    return this.listenerCounts()[code] > 0;
  }

  async start({ title } = {}) {
    if (this.live) return this.status();

    this.startedAt = Date.now();
    this.id = sessionId(this.startedAt);
    this.title = title?.trim() || `Dayjoy Product Training - ${new Date(this.startedAt).toLocaleDateString('en-IN')}`;
    this.incidents = [];
    this.questions.reset();
    this.audioIn = { bytes: 0, chunks: 0, firstAt: 0, lastAt: 0, peak: 0, rms: 0, silentChunks: 0 };

    if (this.config.recording.enabled) {
      this.recorder = new SessionRecorder({
        dir: this.config.recording.dir,
        sessionId: this.id,
        title: this.title,
        config: this.config,
      });
      this.recorder.glossaryVersion = this.glossary.version;
      await this.recorder.init();
    }

    this.pipeline = new Pipeline({
      config: this.config,
      providers: this.providers,
      glossary: this.glossary,
      isChannelActive: (code) => this.isChannelActive(code),
      onOutput: (out) => this.#handleOutput(out),
      onSourceText: (evt) => this.#toConsoles({ type: 'source', ...evt }),
      onIncident: (evt) => this.#handleIncident(evt),
    });

    await this.pipeline.start();
    this.live = true;

    log.info('training live', { id: this.id, title: this.title });
    this.#broadcastStatus();
    return this.status();
  }

  async stop() {
    if (!this.live) return null;
    this.live = false;

    await this.pipeline?.stop();
    // What distributors actually asked is one of the more useful things a
    // training produces, and it is lost the moment the session ends.
    if (this.recorder) this.recorder.questions = this.questions.list();
    const manifest = await this.recorder?.close();

    log.info('training ended', { id: this.id });
    this.#broadcastStatus();
    this.#toConsoles({ type: 'ended', id: this.id, manifest: manifest ? { id: manifest.id } : null });

    this.pipeline = null;
    this.recorder = null;
    return manifest;
  }

  pushTrainerAudio(chunk) {
    const now = Date.now();
    const a = this.audioIn;
    a.bytes += chunk.length;
    a.chunks += 1;
    if (!a.firstAt) a.firstAt = now;
    a.lastAt = now;

    // Sample the level rather than every frame - this runs on every chunk of a
    // 60-minute session and must stay cheap.
    let sum = 0;
    let peak = 0;
    let n = 0;
    for (let i = 0; i + 1 < chunk.length; i += 64) {
      const v = chunk.readInt16LE(i) / 32768;
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
      n += 1;
    }
    const rms = n ? Math.sqrt(sum / n) : 0;
    a.rms = a.rms ? a.rms * 0.9 + rms * 0.1 : rms;
    a.peak = Math.max(a.peak * 0.995, peak);
    if (peak < 0.002) a.silentChunks += 1;

    if (!this.live) return;
    this.pipeline.pushAudio(chunk);
    this.recorder?.appendOriginalAudio(chunk).catch((err) =>
      log.error('failed to archive original audio', { err: err.message })
    );
  }

  setAlignmentDelay(ms) {
    const applied = this.pipeline?.setAlignmentDelay(ms) ?? 0;
    this.#toConsoles({ type: 'aligned', ms: applied });
    return applied;
  }

  // ---- listeners -------------------------------------------------------

  addListener(ws) {
    const entry = { ws, lang: null, joinedAt: Date.now(), bytes: 0 };
    this.listeners.add(entry);
    ws._dayjoy = entry;
    this.#send(ws, { type: 'status', ...this.status() });
    this.#broadcastStatus();
    return entry;
  }

  setListenerLanguage(ws, lang) {
    const entry = ws._dayjoy;
    if (!entry) return;
    const known = this.config.channels.some((c) => c.code === lang);
    if (!known) return;
    entry.lang = lang;
    entry.bytes = 0;
    log.debug('listener switched language', { lang });
    this.#send(ws, { type: 'subscribed', lang });
    this.#broadcastStatus();
  }

  removeListener(ws) {
    const entry = ws._dayjoy;
    if (!entry) return;
    this.listeners.delete(entry);
    this.#broadcastStatus();
  }

  addConsole(ws, role) {
    this.consoles.add({ ws, role });
    this.#send(ws, { type: 'status', ...this.status() });
    // Replay the queue. A trainer who refreshes mid-session, or opens the
    // console after questions have come in, must not silently lose them.
    for (const question of this.questions.list()) {
      this.#send(ws, { type: 'question', question });
    }
  }

  removeConsole(ws) {
    for (const c of this.consoles) if (c.ws === ws) this.consoles.delete(c);
  }

  // ---- fan-out ---------------------------------------------------------

  #handleOutput(out) {
    if (out.type === 'segment') {
      const header = {
        type: 'segment',
        seq: out.seq,
        lang: out.lang,
        text: out.text,
        sourceText: out.sourceText,
        mime: out.mime,
        durationMs: out.durationMs,
        bytes: out.audio.length,
        rate: out.rate,
        flagged: out.flagged,
      };
      for (const l of this.listeners) {
        if (l.lang !== out.lang || l.ws.readyState !== 1) continue;
        this.#send(l.ws, header);
        l.ws.send(out.audio, { binary: true });
        l.bytes += out.audio.length;
      }
      this.recorder
        ?.appendSegment(out.lang, {
          audio: out.audio,
          mime: out.mime,
          durationMs: out.durationMs,
          text: out.text,
          sourceText: out.sourceText,
          seq: out.seq,
          flagged: out.flagged,
        })
        .catch((err) => log.error('failed to archive segment', { err: err.message }));
      this.#toConsoles({ type: 'output', ...header });
      return;
    }

    // Caption-only and skipped segments carry no audio, but the listener is
    // still told - silence with no explanation reads as a broken stream.
    for (const l of this.listeners) {
      if (l.lang === out.lang && l.ws.readyState === 1) this.#send(l.ws, out);
    }
    this.#toConsoles({ type: 'output', ...out });
  }

  #handleIncident(evt) {
    const incident = { ...evt, at: new Date().toISOString() };
    this.incidents.unshift(incident);
    if (this.incidents.length > 100) this.incidents.pop();
    this.#toConsoles({ type: 'incident', incident });
  }

  #send(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  #toConsoles(obj) {
    const payload = JSON.stringify(obj);
    for (const c of this.consoles) if (c.ws.readyState === 1) c.ws.send(payload);
  }

  #broadcastStatus() {
    const status = this.status();
    const payload = JSON.stringify({ type: 'status', ...status });
    for (const l of this.listeners) if (l.ws.readyState === 1) l.ws.send(payload);
    for (const c of this.consoles) if (c.ws.readyState === 1) c.ws.send(payload);
  }

  status() {
    return {
      live: this.live,
      id: this.id,
      title: this.title,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      elapsedMs: this.startedAt && this.live ? Date.now() - this.startedAt : 0,
      listeners: this.listeners.size,
      listenerCounts: this.listenerCounts(),
      audioIn: this.audioInStats(),
      activeChannels: this.config.channels.filter((c) => this.isChannelActive(c.code)).map((c) => c.code),
    };
  }

  stats() {
    return {
      ...this.status(),
      glossary: { version: this.glossary.version, unreviewed: this.glossary.unreviewed() },
      pipeline: this.pipeline?.stats() || null,
      incidents: this.incidents.slice(0, 20),
    };
  }
}
