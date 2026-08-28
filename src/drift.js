/**
 * Queue-drift control - the thing that decides whether a channel is still
 * usable at minute forty.
 *
 * A Telugu rendering of a Hindi sentence is usually longer than the source, so
 * the synthetic voice needs more time to speak each segment than the trainer
 * took to say it. Left alone, every channel falls a little further behind each
 * minute and is half a minute late by the end of the session.
 *
 * Two corrections run together:
 *
 *   - Speech rate. The backlog is measured before each segment is synthesised
 *     and handed to the voice engine as an SSML prosody rate. Asking the engine
 *     to speak faster keeps the voice natural; speeding up playback in the
 *     browser instead would raise the pitch and sound like a cartoon.
 *   - Silence compression. Segments are played back to back rather than at their
 *     original timing, so the gaps where the trainer paused are where the
 *     channel quietly catches up.
 *
 * If the backlog gets past recovery, dropping a segment beats being a minute
 * late - the listener is told, and the channel resynchronises.
 */

const LADDER = [
  { backlogMs: 6000, rate: 1.25 },
  { backlogMs: 4000, rate: 1.15 },
  { backlogMs: 2500, rate: 1.08 },
  { backlogMs: 0, rate: 1.0 },
];

export class DriftController {
  constructor({ dropThresholdMs = 15000, ladder = LADDER } = {}) {
    this.dropThresholdMs = dropThresholdMs;
    this.ladder = ladder;
    this.queueEndsAt = 0;
    this.spokenMs = 0;
    this.droppedSegments = 0;
    this.maxBacklogMs = 0;
  }

  /** How far behind the live trainer this channel currently is. */
  backlogMs(now = Date.now()) {
    return Math.max(0, this.queueEndsAt - now);
  }

  /** Speech rate to synthesise the next segment at. */
  nextRate(now = Date.now()) {
    const backlog = this.backlogMs(now);
    for (const step of this.ladder) {
      if (backlog >= step.backlogMs) return step.rate;
    }
    return 1.0;
  }

  /** True when the channel is beyond catching up and should skip this segment. */
  shouldDrop(now = Date.now()) {
    return this.backlogMs(now) > this.dropThresholdMs;
  }

  /** Record that `durationMs` of audio has been queued for playback. */
  commit(durationMs, now = Date.now()) {
    this.queueEndsAt = Math.max(now, this.queueEndsAt) + durationMs;
    this.spokenMs += durationMs;
    this.maxBacklogMs = Math.max(this.maxBacklogMs, this.backlogMs(now));
  }

  noteDrop() {
    this.droppedSegments += 1;
  }

  stats(now = Date.now()) {
    return {
      backlogMs: Math.round(this.backlogMs(now)),
      maxBacklogMs: Math.round(this.maxBacklogMs),
      spokenMs: Math.round(this.spokenMs),
      droppedSegments: this.droppedSegments,
      rate: this.nextRate(now),
    };
  }
}

/** SSML prosody value for a rate multiplier: 1.15 becomes "+15%". */
export function rateToSsml(rate) {
  const pct = Math.round((rate - 1) * 100);
  if (pct === 0) return '0%';
  return `${pct > 0 ? '+' : ''}${pct}%`;
}
