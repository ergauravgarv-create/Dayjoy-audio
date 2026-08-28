import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { screenSource, validateSegment } from '../src/validator.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const glossary = JSON.parse(await readFile(join(ROOT, 'config', 'glossary.json'), 'utf8'));

const flagged = (source) => screenSource({ source, glossary });

test('catches a cure claim the trainer made in romanised Hindi', () => {
  const r = flagged('Ye product diabetes ko theek karta hai');
  assert.equal(r.ok, false);
  assert.ok(r.flags.some((f) => f.kind === 'trainer-claim'));
  assert.ok(r.flags.some((f) => f.kind === 'restricted-condition'));
});

test('catches the same claim written in Devanagari', () => {
  const r = flagged('यह दवा है और बीमारी दूर करती है');
  assert.equal(r.ok, false);
  assert.ok(r.flags.length > 0);
});

test('catches immunity-booster language, which the drift guard never saw', () => {
  const r = flagged('Ye immunity booster hai');
  assert.equal(r.ok, false);
  assert.ok(r.flags.some((f) => f.term === 'immunity booster'));
});

test('catches a safety absolute', () => {
  assert.equal(flagged('Iska koi side effect nahi hai, 100% safe hai').ok, false);
  assert.equal(flagged('Results are guaranteed').ok, false);
});

test('catches a named condition even in an otherwise careful sentence', () => {
  const r = flagged('Bahut se log cancer ke baare mein poochte hain');
  assert.equal(r.ok, false);
  assert.equal(r.flags[0].kind, 'restricted-condition');
});

test('leaves ordinary training talk alone', () => {
  assert.equal(flagged('Recommended dosage 5 se 10 ml daily hai, subah khali pet').ok, true);
  assert.equal(flagged('Ek bottle mein 500 ml product aata hai aur iska BV 1200 hai').ok, true);
  assert.equal(flagged('Namaskar sabhi distributors ko').ok, true);
});

test('one mention produces one warning, not four', () => {
  const r = flagged('diabetes diabetes diabetes');
  assert.equal(r.flags.length, 1);
});

test('a faithful translation of the trainer\'s own claim is not reported as model drift', () => {
  // Before the source guard covered Hindi, this came back as "the translation
  // introduced a claim term" - blaming the model for the trainer's words.
  const r = validateSegment({
    source: 'Ye bimari door karta hai aur ilaj hai',
    target: 'ఇది వ్యాధిని నివారిస్తుంది',
    lang: 'te',
    glossary,
  });
  assert.equal(r.ok, true, JSON.stringify(r.critical));
});

test('the model inventing a claim is still caught', () => {
  const r = validateSegment({
    source: 'Ye product roz subah lena hai',
    target: 'ఇది వ్యాధిని నివారిస్తుంది',
    lang: 'te',
    glossary,
  });
  assert.equal(r.ok, false);
  assert.ok(r.critical.some((c) => c.kind === 'claim-drift'));
});

test('the claims we missed are now catalogued', () => {
  const sources = glossary.claims.map((c) => c.source);
  assert.ok(sources.includes('rich in antioxidants'));
  assert.ok(sources.includes('has a high ORAC value'));
  assert.ok(sources.includes('may be used together with other Dayjoy products'));
});
