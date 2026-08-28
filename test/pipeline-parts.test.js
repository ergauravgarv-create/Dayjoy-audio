import test from 'node:test';
import assert from 'node:assert/strict';
import { Segmenter } from '../src/segmenter.js';
import { DriftController, rateToSsml } from '../src/drift.js';
import { Glossary } from '../src/glossary.js';

// ---------------------------------------------------------------- segmenter

test('a complete sentence is emitted immediately', () => {
  const out = [];
  const s = new Segmenter({ onSegment: (seg) => out.push(seg) });
  s.push('Sea Buckthorn ek powerful antioxidant berry hai', 1000);
  assert.equal(out.length, 1);
  assert.equal(out[0].reason, 'complete');
});

test('a one-word fragment is held back for its neighbour', () => {
  const out = [];
  const s = new Segmenter({ onSegment: (seg) => out.push(seg) });
  s.push('Haan.', 1000);
  assert.equal(out.length, 0, 'too short to spend a translate-and-speak round trip on');

  s.push('Theek hai, aage badhte hain.', 1400);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Haan. Theek hai, aage badhte hain.');
});

test('a held fragment does not wait forever', () => {
  const out = [];
  const s = new Segmenter({ coalesceWindowMs: 1200, onSegment: (seg) => out.push(seg) });
  s.push('Haan.', 1000);
  s.tick(1500);
  assert.equal(out.length, 0);
  s.tick(2300);
  assert.equal(out.length, 1);
  assert.equal(out[0].reason, 'coalesce-timeout');
});

test('a trainer who never pauses still gets segmented', () => {
  const out = [];
  const s = new Segmenter({ maxSegmentChars: 40, onSegment: (seg) => out.push(seg) });
  s.push('a'.repeat(45), 1000);
  assert.equal(out.length, 1);
  assert.equal(out[0].reason, 'max-chars');
});

// -------------------------------------------------------------------- drift

test('speech rate rises as the channel falls behind', () => {
  const d = new DriftController();
  const t0 = 100000;
  assert.equal(d.nextRate(t0), 1.0);

  d.commit(3000, t0); // 3s of audio queued
  assert.equal(d.nextRate(t0), 1.08);

  d.commit(2000, t0); // now 5s behind
  assert.equal(d.nextRate(t0), 1.15);

  d.commit(3000, t0); // 8s behind
  assert.equal(d.nextRate(t0), 1.25);
});

test('the backlog drains as wall-clock time passes', () => {
  const d = new DriftController();
  const t0 = 100000;
  d.commit(4000, t0);
  assert.equal(d.backlogMs(t0), 4000);
  assert.equal(d.backlogMs(t0 + 3000), 1000);
  assert.equal(d.backlogMs(t0 + 9000), 0);
});

test('a hopeless backlog asks to drop rather than run a minute late', () => {
  const d = new DriftController({ dropThresholdMs: 15000 });
  const t0 = 100000;
  d.commit(10000, t0);
  assert.equal(d.shouldDrop(t0), false);
  d.commit(8000, t0);
  assert.equal(d.shouldDrop(t0), true);
});

test('rates convert to SSML percentages', () => {
  assert.equal(rateToSsml(1.0), '0%');
  assert.equal(rateToSsml(1.15), '+15%');
  assert.equal(rateToSsml(0.9), '-10%');
});

// ----------------------------------------------------------------- glossary

const raw = {
  version: 'test',
  terms: [
    {
      term: 'Super Richberries',
      policy: 'keep',
      aliases: ['super rich berries'],
      say: { te: 'సూపర్ రిచ్‌బెర్రీస్' },
    },
    { term: 'BV', policy: 'keep', aliases: [], say: { te: 'బీవీ' } },
    { term: 'antioxidant', policy: 'render', aliases: [], translations: { te: 'యాంటీఆక్సిడెంట్' } },
  ],
  claims: [],
};

test('detects a brand term regardless of casing', () => {
  const g = new Glossary(raw);
  const m = g.detect('aaj hum SUPER RICHBERRIES ke baare mein baat karenge');
  assert.equal(m.terms.length, 1);
  assert.equal(m.terms[0].term, 'Super Richberries');
});

test('does not fire on a term embedded in a longer word', () => {
  const g = new Glossary(raw);
  assert.equal(g.detect('BVLGARI perfume').terms.length, 0);
  assert.equal(g.detect('iska BV 1200 hai').terms.length, 1);
});

test('swaps a Latin brand name for its native spelling so the voice says it right', () => {
  const g = new Glossary(raw);
  const matches = g.detect('Super Richberries ek antioxidant hai');
  const fixed = g.enforce('Super Richberries ఒక యాంటీఆక్సిడెంట్', matches, 'te');
  assert.equal(fixed, 'సూపర్ రిచ్‌బెర్రీస్ ఒక యాంటీఆక్సిడెంట్');
});

test('leaves an already-correct translation alone', () => {
  const g = new Glossary(raw);
  const matches = g.detect('Super Richberries ek antioxidant hai');
  const already = 'సూపర్ రిచ్‌బెర్రీస్ ఒక యాంటీఆక్సిడెంట్';
  assert.equal(g.enforce(already, matches, 'te'), already);
});

test('builds prompt directives only for the terms in this segment', () => {
  const g = new Glossary(raw);
  const lines = g.directives(g.detect('iska BV 1200 hai'), 'te');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /బీవీ/);
});
