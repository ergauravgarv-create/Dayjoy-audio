import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestionBoard } from '../src/questions.js';

const te = { code: 'te', name: 'Telugu', locale: 'te-IN' };

function board(translator) {
  const seen = [];
  const b = new QuestionBoard({
    translator: translator || { async translate({ text }) { return { hi: `[hi] ${text}`, en: `[en] ${text}`, via: 'mock' }; } },
    onQuestion: (q) => seen.push({ id: q.id, hi: q.hi }),
  });
  return { b, seen };
}

test('a typed question reaches the trainer translated', async () => {
  const { b } = board();
  const q = await b.submit({ text: 'Dosage roju entha?', channel: te, askedBy: 'Padma', key: 'k1' });
  assert.equal(q.original, 'Dosage roju entha?');
  assert.equal(q.hi, '[hi] Dosage roju entha?');
  assert.equal(q.langName, 'Telugu');
  assert.equal(q.askedBy, 'Padma');
  assert.equal(q.answered, false);
});

test('the trainer sees it immediately, then again once translated', async () => {
  // A question that appears two seconds late is still useful; one that never
  // appears because translation failed is not.
  const { b, seen } = board();
  await b.submit({ text: 'test', channel: te, key: 'k1' });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].hi, '');
  assert.equal(seen[1].hi, '[hi] test');
});

test('a failed translation still delivers the original', async () => {
  const { b } = board({ async translate() { throw new Error('provider down'); } });
  const q = await b.submit({ text: 'ఇది ఏమిటి?', channel: te, key: 'k1' });
  assert.equal(q.original, 'ఇది ఏమిటి?');
  assert.equal(q.hi, '');
});

test('empty questions are refused', async () => {
  const { b } = board();
  await assert.rejects(() => b.submit({ text: '   ', channel: te, key: 'k1' }), /type a question/i);
});

test('very long questions are trimmed, not rejected', async () => {
  const { b } = board();
  const q = await b.submit({ text: 'x'.repeat(900), channel: te, key: 'k1' });
  assert.equal(q.original.length, 500);
});

test('one person cannot flood the queue', async () => {
  const { b } = board();
  for (let i = 0; i < 5; i++) await b.submit({ text: `q${i}`, channel: te, key: 'same' });
  await assert.rejects(() => b.submit({ text: 'q6', channel: te, key: 'same' }), /wait a minute/i);
});

test('the flood guard is per person, not global', async () => {
  const { b } = board();
  for (let i = 0; i < 5; i++) await b.submit({ text: `q${i}`, channel: te, key: 'person-a' });
  const q = await b.submit({ text: 'mine', channel: te, key: 'person-b' });
  assert.equal(q.original, 'mine');
});

test('answered state can be set and cleared', async () => {
  const { b } = board();
  const q = await b.submit({ text: 'q', channel: te, key: 'k1' });
  assert.equal(b.pendingCount(), 1);
  b.markAnswered(q.id);
  assert.equal(b.pendingCount(), 0);
  b.markAnswered(q.id, false);
  assert.equal(b.pendingCount(), 1);
});

test('a new session starts with an empty board', async () => {
  const { b } = board();
  await b.submit({ text: 'q', channel: te, key: 'k1' });
  b.reset();
  assert.equal(b.list().length, 0);
  // and the flood guard resets too, so yesterday's questions do not block today
  for (let i = 0; i < 5; i++) await b.submit({ text: `q${i}`, channel: te, key: 'k1' });
  assert.equal(b.list().length, 5);
});
