import test from 'node:test';
import assert from 'node:assert/strict';
import { extractNumbers, validateSegment } from '../src/validator.js';
import { normaliseDigits } from '../src/digits.js';

const glossary = {
  forbiddenClaimTerms: {
    en: ['cure', 'treats', 'prevents disease'],
    te: ['నయం', 'చికిత్స'],
  },
};

test('pulls plain numbers out of a sentence', () => {
  assert.deepEqual(extractNumbers('Recommended dosage 5 se 10 ml daily hai'), ['5', '10']);
});

test('treats commas as Indian group separators, not decimals', () => {
  assert.deepEqual(extractNumbers('iska BV 1,200 hai aur target 1,20,000'), ['1200', '120000']);
});

test('keeps decimals and drops trailing zeros', () => {
  assert.deepEqual(extractNumbers('2.5 ml aur 5.0 ml'), ['2.5', '5']);
});

test('folds Indic digits to ASCII before comparing', () => {
  assert.equal(normaliseDigits('౫ నుండి ౧౦ మి.లీ.'), '5 నుండి 10 మి.లీ.');
  assert.deepEqual(extractNumbers('৫ থেকে ১০ মিলি'), ['5', '10']);
});

test('a dosage translated into Telugu digits still validates', () => {
  const result = validateSegment({
    source: 'Recommended dosage 5 se 10 ml daily hai',
    target: 'సిఫార్సు చేసిన మోతాదు రోజుకు ౫ నుండి ౧౦ మి.లీ.',
    lang: 'te',
    glossary,
  });
  assert.equal(result.ok, true, JSON.stringify(result.critical));
});

test('catches a dosage that drifted from 5-10 ml to 50 ml', () => {
  const result = validateSegment({
    source: 'Recommended dosage 5 se 10 ml daily hai',
    target: 'సిఫార్సు చేసిన మోతాదు రోజుకు 50 మి.లీ.',
    lang: 'te',
    glossary,
  });
  assert.equal(result.ok, false);
  assert.ok(result.critical.some((c) => c.kind === 'number-missing'));
  assert.ok(result.critical.some((c) => c.kind === 'number-invented'));
});

test('catches a figure the model invented', () => {
  const result = validateSegment({
    source: 'Ek bottle mein 500 ml product aata hai',
    target: 'ఒక సీసాలో 500 మి.లీ. ఉత్పత్తి 90 రోజులు వస్తుంది',
    lang: 'te',
    glossary,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.critical.find((c) => c.kind === 'number-invented').numbers,
    ['90']
  );
});

test('flags a claim strengthened on the way through the model', () => {
  const result = validateSegment({
    source: 'Ye product cellular protection ko support karta hai',
    target: 'ఈ ఉత్పత్తి వ్యాధికి నయం చేస్తుంది',
    lang: 'te',
    glossary,
  });
  assert.equal(result.ok, false);
  assert.ok(result.critical.some((c) => c.kind === 'claim-drift'));
});

test('allows a claim term the source itself used', () => {
  const result = validateSegment({
    source: 'This is not a cure for any disease',
    target: 'ఇది ఏ వ్యాధికీ నయం కాదు',
    lang: 'te',
    glossary,
  });
  assert.equal(result.ok, true, JSON.stringify(result.critical));
});

test('a brand name containing digits is not mistaken for a lost dosage', () => {
  // Fit90 becomes "ఫిట్ నైంటీ" - spelled out, no digits. The 90 inside the brand
  // name must not be counted, or every mention gets withheld from the audio.
  const termMatches = [
    { term: 'Fit90', policy: 'keep', aliases: ['fit 90'], say: { te: 'ఫిట్ నైంటీ' } },
  ];
  const result = validateSegment({
    source: 'Dayjoy Fit90 program ke saath ye product 90 din tak lena hai',
    target: 'డేజాయ్ ఫిట్ నైంటీ ప్రోగ్రామ్‌తో ఈ ఉత్పత్తిని 90 రోజులు తీసుకోవాలి',
    lang: 'te',
    termMatches,
    glossary,
  });
  assert.equal(result.ok, true, JSON.stringify(result.critical));
});

test('a real dosage is still caught when a numeric brand name is present', () => {
  const termMatches = [
    { term: 'Fit90', policy: 'keep', aliases: ['fit 90'], say: { te: 'ఫిట్ నైంటీ' } },
  ];
  const result = validateSegment({
    source: 'Fit90 ke saath 5 ml lena hai',
    target: 'ఫిట్ నైంటీ తో 50 మి.లీ. తీసుకోవాలి',
    lang: 'te',
    termMatches,
    glossary,
  });
  assert.equal(result.ok, false);
  assert.ok(result.critical.some((c) => c.kind === 'number-missing'));
});

test('warns when a protected term did not survive', () => {
  const result = validateSegment({
    source: 'Super Richberries ek antioxidant hai',
    target: 'సూపర్ రిచ్ బెర్రీలు ఒక యాంటీఆక్సిడెంట్',
    lang: 'te',
    termMatches: [{ term: 'Super Richberries', policy: 'keep', say: { te: 'సూపర్ రిచ్‌బెర్రీస్' } }],
    glossary,
  });
  assert.equal(result.ok, true, 'a mangled brand name is a warning, not a stop-ship');
  assert.ok(result.warnings.some((w) => w.kind === 'term-missing'));
});
