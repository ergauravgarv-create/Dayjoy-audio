import { Segmenter } from './segmenter.js';
import { DriftController } from './drift.js';
import { validateSegment, screenSource } from './validator.js';
import { logger } from './log.js';

const log = logger('pipeline');

const CONTEXT_SEGMENTS = 3;
const LATENCY_SAMPLES = 200;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

/**
 * Recognise once, then fan out per language.
 *
 * Everything up to segmentation happens a single time no matter how many people
 * are listening. Only translation and voice fork, and they fork per language -
 * never per participant - so a hundred and fifty Telugu listeners share one
 * Telugu channel and the expensive half of the pipeline never notices the
 * audience size.
 *
 * Each channel processes its segments strictly in order through its own promise
 * chain, so channels run in parallel with each other but a listener never hears
 * sentence four before sentence three.
 */
export class Pipeline {
  constructor({ config, providers, glossary, onOutput, onSourceText, onIncident, isChannelActive }) {
    this.config = config;
    this.providers = providers;
    this.glossary = glossary;
    this.onOutput = onOutput;
    this.onSourceText = onSourceText || (() => {});
    this.onIncident = onIncident || (() => {});
    // A language with nobody listening costs nothing to skip. This is where the
    // "translate only the languages actually in use" saving is realised.
    this.isChannelActive = isChannelActive || (() => true);

    this.alignmentDelayMs = config.defaultAlignmentDelayMs;
    this.running = false;

    this.channels = new Map();
    for (const channel of config.translateChannels) {
      this.channels.set(channel.code, {
        channel,
        drift: new DriftController({ dropThresholdMs: config.drift.dropThresholdMs }),
        chain: Promise.resolve(),
        context: [],
        lastScheduledAt: 0,
        stats: { segments: 0, retries: 0, failures: 0, flagged: 0, fallbacks: 0 },
      });
    }

    this.latencies = [];
    this.totals = { phrases: 0, segments: 0, charsIn: 0, charsOut: 0 };

    this.segmenter = new Segmenter({
      ...config.segmenter,
      onSegment: (segment) => this.#dispatch(segment),
    });
  }

  async start() {
    if (this.running) return;
    this.running = true;

    this.tickTimer = setInterval(() => this.segmenter.tick(), 300);
    if (typeof this.tickTimer.unref === 'function') this.tickTimer.unref();

    await this.providers.asr.start({
      onPartial: (text) => this.onSourceText({ kind: 'partial', text }),
      onPhrase: (text) => {
        this.totals.phrases += 1;
        this.onSourceText({ kind: 'phrase', text });
        this.segmenter.push(text);
      },
      onError: (err) => {
        log.error('recogniser error', { err: err.message });
        this.onIncident({ kind: 'asr-error', detail: err.message });
      },
    });

    log.info('pipeline started', { channels: [...this.channels.keys()].join(',') });
  }

  pushAudio(chunk) {
    if (this.running) this.providers.asr.pushAudio(chunk);
  }

  setAlignmentDelay(ms) {
    this.alignmentDelayMs = Math.max(0, Math.min(8000, Number(ms) || 0));
    log.info('alignment delay set', { ms: this.alignmentDelayMs });
    return this.alignmentDelayMs;
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.tickTimer);
    this.segmenter.flush(Date.now(), 'session-end');
    await this.providers.asr.stop();
    await Promise.allSettled([...this.channels.values()].map((c) => c.chain));
    log.info('pipeline stopped', this.totals);
  }

  #dispatch(segment) {
    this.totals.segments += 1;
    this.totals.charsIn += segment.text.length;

    const matches = this.glossary.detect(segment.text);

    // Screen the trainer's own words once, before any translation. This is
    // source-side and language-independent, so it does not belong in the
    // per-channel loop below.
    const screened = screenSource({ source: segment.text, glossary: this.glossary.raw });
    if (!screened.ok) {
      this.totals.sourceFlags = (this.totals.sourceFlags || 0) + 1;
      log.warn('trainer used claim language', {
        seq: segment.seq,
        terms: screened.flags.map((f) => f.term).join(', '),
      });
      this.onIncident({
        kind: 'source-claim-risk',
        seq: segment.seq,
        sourceText: segment.text,
        issues: screened.flags,
      });
    }

    for (const state of this.channels.values()) {
      if (!this.isChannelActive(state.channel.code)) continue;
      state.chain = state.chain
        .then(() => this.#processChannel(state, segment, matches))
        .catch((err) => {
          state.stats.failures += 1;
          log.error('channel failed', { lang: state.channel.code, seq: segment.seq, err: err.message });
          this.onIncident({
            kind: 'channel-error',
            lang: state.channel.code,
            seq: segment.seq,
            detail: err.message,
          });
        });
    }
  }

  async #translateWithFallback(args) {
    try {
      return await this.providers.mt.translate(args);
    } catch (err) {
      if (!this.providers.mtFallback) throw err;
      log.warn('primary translator failed, falling back', {
        lang: args.channel.code,
        err: err.message,
      });
      this.onIncident({
        kind: 'mt-fallback',
        lang: args.channel.code,
        seq: args.seq,
        detail: err.message,
      });
      return this.providers.mtFallback.translate(args);
    }
  }

  async #processChannel(state, segment, matches) {
    const { channel, drift } = state;
    const now = Date.now();

    // Past recovery. Skipping one sentence beats being half a minute late for
    // the rest of the session; the listener is told, and the channel resyncs.
    if (drift.shouldDrop(now)) {
      drift.noteDrop();
      log.warn('dropped segment to resynchronise', {
        lang: channel.code,
        seq: segment.seq,
        backlogMs: Math.round(drift.backlogMs(now)),
      });
      this.onOutput({
        type: 'skipped',
        lang: channel.code,
        seq: segment.seq,
        sourceText: segment.text,
        reason: 'catching-up',
      });
      return;
    }

    // A health claim nobody has cleared for this language does not get spoken.
    // The sentence still reaches the listener as a caption and the trainer is
    // told, so the point can be made — just not by a synthetic voice on the
    // company's behalf.
    const blocked = this.glossary.blockedClaims(matches, channel.code);
    if (blocked.length && this.config.requireClaimSignoff) {
      state.stats.claimsBlocked = (state.stats.claimsBlocked || 0) + 1;
      state.stats.flagged += 1;
      log.warn('segment withheld: claim not signed off', {
        lang: channel.code,
        seq: segment.seq,
        claims: blocked.map((b) => b.claim.source).join(' | '),
      });
      this.onIncident({
        kind: 'claim-not-approved',
        lang: channel.code,
        seq: segment.seq,
        sourceText: segment.text,
        issues: blocked.map((b) => ({ kind: 'claim-not-approved', detail: b.reason })),
      });
      this.onOutput({
        type: 'caption-only',
        lang: channel.code,
        seq: segment.seq,
        text: '',
        sourceText: segment.text,
        flagged: true,
        reason: 'claim-not-approved',
        issues: blocked.map((b) => b.reason),
      });
      return;
    }

    const directives = this.glossary.directives(matches, channel.code);
    const baseArgs = { text: segment.text, channel, directives, context: state.context, seq: segment.seq };

    let result = await this.#translateWithFallback(baseArgs);
    let target = this.glossary.enforce(result.text, matches, channel.code);

    let check = validateSegment({
      source: segment.text,
      target,
      lang: channel.code,
      termMatches: matches.terms,
      glossary: this.glossary.raw,
    });

    if (!check.ok) {
      state.stats.retries += 1;
      log.warn('validation failed, retrying strictly', {
        lang: channel.code,
        seq: segment.seq,
        issues: check.critical.map((c) => c.kind).join(','),
      });
      result = await this.#translateWithFallback({ ...baseArgs, strict: true });
      target = this.glossary.enforce(result.text, matches, channel.code);
      check = validateSegment({
        source: segment.text,
        target,
        lang: channel.code,
        termMatches: matches.terms,
        glossary: this.glossary.raw,
      });
    }

    // Still wrong after a strict retry. A dosage that drifted from 5-10 ml to
    // 50 ml must never be spoken, so this segment goes out as a caption only and
    // the trainer console raises a flag so the trainer can repeat the figure.
    if (!check.ok) {
      state.stats.fallbacks += 1;
      state.stats.flagged += 1;
      log.error('segment withheld from audio after failed revalidation', {
        lang: channel.code,
        seq: segment.seq,
        issues: check.critical.map((c) => c.detail).join(' | '),
      });
      this.onIncident({
        kind: 'segment-withheld',
        lang: channel.code,
        seq: segment.seq,
        sourceText: segment.text,
        targetText: target,
        issues: check.critical,
      });
      this.onOutput({
        type: 'caption-only',
        lang: channel.code,
        seq: segment.seq,
        text: target,
        sourceText: segment.text,
        flagged: true,
        issues: check.critical.map((c) => c.detail),
      });
      return;
    }

    const rate = drift.nextRate(Date.now());
    const spoken = await this.providers.tts.synthesise({ text: target, channel, rate });

    drift.commit(spoken.durationMs, Date.now());
    state.stats.segments += 1;
    this.totals.charsOut += target.length;

    state.context.push({ source: segment.text, target });
    if (state.context.length > CONTEXT_SEGMENTS) state.context.shift();

    const flagged = check.warnings.length > 0;
    if (flagged) state.stats.flagged += 1;

    // Monotonic scheduling. The alignment delay holds translated audio back so
    // it does not arrive before the Zoom video it is describing, and taking the
    // max with the previous slot keeps segments in order even if the trainer
    // moves the slider mid-session.
    const readyAt = Date.now();
    const scheduledAt = Math.max(readyAt + this.alignmentDelayMs, state.lastScheduledAt + 1);
    state.lastScheduledAt = scheduledAt;

    const emit = () => {
      this.#recordLatency(Date.now() - segment.endedAt);
      this.onOutput({
        type: 'segment',
        lang: channel.code,
        seq: segment.seq,
        text: target,
        sourceText: segment.text,
        audio: spoken.audio,
        mime: spoken.mime,
        durationMs: spoken.durationMs,
        rate,
        voice: spoken.voice || null,
        flagged,
        warnings: check.warnings.map((w) => w.detail),
      });
    };

    const wait = scheduledAt - Date.now();
    if (wait > 0) setTimeout(emit, wait);
    else emit();
  }

  #recordLatency(ms) {
    this.latencies.push(ms);
    if (this.latencies.length > LATENCY_SAMPLES) this.latencies.shift();
  }

  /** Everything the admin console needs to see whether the session is healthy. */
  stats() {
    const now = Date.now();
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      running: this.running,
      alignmentDelayMs: this.alignmentDelayMs,
      totals: this.totals,
      latency: {
        samples: sorted.length,
        medianMs: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
      },
      channels: [...this.channels.values()].map((s) => ({
        code: s.channel.code,
        name: s.channel.name,
        native: s.channel.native,
        ...s.drift.stats(now),
        ...s.stats,
      })),
    };
  }
}
