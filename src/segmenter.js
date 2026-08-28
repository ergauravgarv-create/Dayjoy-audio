/**
 * Turns a stream of recognised phrases into translation units.
 *
 * The recogniser already ends a phrase when the trainer pauses, but raw phrase
 * events are a bad unit of work: "Haan." and "Theek hai." arrive as their own
 * segments and each one costs a full translate-and-speak round trip, which makes
 * the channel choppy and expensive. So very short fragments are held briefly and
 * merged into whatever comes next.
 *
 * Nothing partial is ever emitted. Translating an unfinished clause and then
 * correcting it is what produces the stutter that makes these systems feel
 * broken, so a segment leaves here only when it is known to be complete.
 */
export class Segmenter {
  constructor({
    minWordsStandalone = 3,
    coalesceWindowMs = 1200,
    maxSegmentChars = 320,
    maxSegmentMs = 12000,
    onSegment = () => {},
  } = {}) {
    this.minWordsStandalone = minWordsStandalone;
    this.coalesceWindowMs = coalesceWindowMs;
    this.maxSegmentChars = maxSegmentChars;
    this.maxSegmentMs = maxSegmentMs;
    this.onSegment = onSegment;

    this.pending = '';
    this.pendingStartedAt = 0;
    this.seq = 0;
  }

  /** Feed one finalised phrase from the recogniser. */
  push(text, now = Date.now()) {
    const clean = (text || '').trim();
    if (!clean) return;

    if (!this.pending) this.pendingStartedAt = now;
    this.pending = this.pending ? `${this.pending} ${clean}` : clean;

    if (this.pending.length >= this.maxSegmentChars) return this.flush(now, 'max-chars');
    if (now - this.pendingStartedAt >= this.maxSegmentMs) return this.flush(now, 'max-age');
    if (this.wordCount() >= this.minWordsStandalone) return this.flush(now, 'complete');
    // Too short to stand on its own - hold it for the next phrase.
  }

  /** Called on a timer so a held fragment does not wait forever for a partner. */
  tick(now = Date.now()) {
    if (!this.pending) return;
    if (now - this.pendingStartedAt >= this.coalesceWindowMs) this.flush(now, 'coalesce-timeout');
  }

  wordCount() {
    return this.pending ? this.pending.split(/\s+/).filter(Boolean).length : 0;
  }

  flush(now = Date.now(), reason = 'manual') {
    if (!this.pending) return;
    const segment = {
      seq: ++this.seq,
      text: this.pending,
      startedAt: this.pendingStartedAt,
      endedAt: now,
      reason,
    };
    this.pending = '';
    this.pendingStartedAt = 0;
    this.onSegment(segment);
    return segment;
  }
}
