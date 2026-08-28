import { normaliseDigits } from './digits.js';

/**
 * Post-translation safety checks.
 *
 * Three things are verified on every segment before it is allowed to reach a
 * listener's ear:
 *
 *   1. Every number in the source survives into the translation. A dosage that
 *      drifts from "5-10 ml" to "50 ml" is the worst failure this system can
 *      produce, so it is treated as critical and re-run rather than shipped.
 *   2. Protected brand terms appear in their approved native-script spelling.
 *   3. No claim term appears in the translation that had no counterpart in the
 *      source - the guard against a permissible claim being strengthened into a
 *      medical one on its way through the model.
 */

const NUMBER_RE = /\d+(?:[.,]\d+)*/g;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Blank out protected terms before counting digits.
 *
 * Brand names carry their own numbers - Fit90, Curind 500 - and the approved
 * native spelling usually writes them as words ("ఫిట్ నైంటీ"). Counting those
 * digits as if they were dosages makes every mention of Fit90 look like a
 * figure that went missing in translation, and the sentence gets withheld for
 * no reason. Only the free-standing numbers are the ones worth protecting.
 */
function maskTerms(text, entries, lang) {
  let out = text || '';
  for (const entry of entries) {
    const candidates = [
      ...(entry.candidates || [entry.term, ...(entry.aliases || [])]),
      entry.say?.[lang],
      entry.translations?.[lang],
    ].filter(Boolean);

    for (const candidate of candidates) {
      out = out.replace(new RegExp(escapeRegExp(candidate), 'gi'), ' ');
    }
  }
  return out;
}

/** Pull every numeric literal out of `text` as a canonical ASCII string. */
export function extractNumbers(text) {
  const found = normaliseDigits(text || '').match(NUMBER_RE) || [];
  return found.map(canonicaliseNumber).filter((n) => n !== null);
}

function canonicaliseNumber(raw) {
  // Indian grouping ("1,20,000") uses commas as separators, never as decimals.
  const hasDecimal = /\.\d/.test(raw);
  const cleaned = raw.replace(/,/g, '');
  const value = hasDecimal ? parseFloat(cleaned) : parseInt(cleaned, 10);
  if (!Number.isFinite(value)) return null;
  return String(value);
}

function multisetDiff(a, b) {
  const counts = new Map();
  for (const x of b) counts.set(x, (counts.get(x) || 0) + 1);
  const missing = [];
  for (const x of a) {
    const n = counts.get(x) || 0;
    if (n === 0) missing.push(x);
    else counts.set(x, n - 1);
  }
  return missing;
}

/**
 * Screens what the TRAINER said, before anything is translated.
 *
 * Every other check in this file watches the model for drift. None of them
 * watch the trainer, and a trainer improvising "yeh diabetes theek karta hai"
 * is at least as likely a problem as the model strengthening a claim - more so
 * in a distributor network where sessions are unscripted.
 *
 * This warns and records; it never blocks. "This does not treat diabetes" is a
 * legitimate sentence, and a system that silenced it would be quickly ignored.
 */
export function screenSource({ source, glossary }) {
  const text = (source || '').toLowerCase();
  const flags = [];

  for (const lang of glossary?.forbiddenClaimTerms?._sourceLangs || ['en', 'hi']) {
    for (const term of glossary?.forbiddenClaimTerms?.[lang] || []) {
      if (text.includes(term.toLowerCase())) {
        flags.push({
          kind: 'trainer-claim',
          term,
          detail: `The trainer said "${term}" - this is claim language and needs checking.`,
        });
      }
    }
  }

  for (const condition of glossary?.restrictedConditions?.terms || []) {
    if (text.includes(condition.toLowerCase())) {
      flags.push({
        kind: 'restricted-condition',
        term: condition,
        detail: `A named medical condition ("${condition}") came up. Naming a condition alongside a product is what the Drugs and Magic Remedies Act restricts.`,
      });
    }
  }

  // One mention of "diabetes" should not produce four identical warnings.
  const seen = new Set();
  return {
    ok: flags.length === 0,
    flags: flags.filter((f) => {
      const k = `${f.kind}:${f.term}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
  };
}

/**
 * @param {object} args
 * @param {string} args.source        Recognised Hindi/English text.
 * @param {string} args.target        Translated text.
 * @param {string} args.lang          Channel code, e.g. "te".
 * @param {Array}  args.termMatches   Glossary entries detected in the source.
 * @param {object} args.glossary      Full loaded glossary (for forbidden terms).
 */
export function validateSegment({ source, target, lang, termMatches = [], glossary = null }) {
  const critical = [];
  const warnings = [];

  const srcNums = extractNumbers(maskTerms(source, termMatches, lang));
  const tgtNums = extractNumbers(maskTerms(target, termMatches, lang));

  const missing = multisetDiff(srcNums, tgtNums);
  if (missing.length) {
    critical.push({
      kind: 'number-missing',
      detail: `Source figures absent from translation: ${missing.join(', ')}`,
      numbers: missing,
    });
  }

  const invented = multisetDiff(tgtNums, srcNums);
  if (invented.length) {
    critical.push({
      kind: 'number-invented',
      detail: `Translation contains figures not present in the source: ${invented.join(', ')}`,
      numbers: invented,
    });
  }

  for (const entry of termMatches) {
    if (entry.policy !== 'keep') continue;
    const expected = entry.say?.[lang];
    if (!expected) {
      warnings.push({
        kind: 'term-no-spelling',
        detail: `No approved ${lang} spelling for "${entry.term}" - the voice engine will guess.`,
        term: entry.term,
      });
      continue;
    }
    if (!target.includes(expected)) {
      warnings.push({
        kind: 'term-missing',
        detail: `Protected term "${entry.term}" did not survive as "${expected}".`,
        term: entry.term,
      });
    }
  }

  const forbidden = glossary?.forbiddenClaimTerms?.[lang] || [];
  // The source is Hindi mixed with English, so checking only the English list
  // meant a trainer's Hindi claim was invisible - and a faithful translation of
  // it got reported as the model inventing a claim, which is the wrong story.
  const sourceGuards = [
    ...(glossary?.forbiddenClaimTerms?.en || []),
    ...(glossary?.forbiddenClaimTerms?.hi || []),
  ];
  if (forbidden.length) {
    const lowerSource = (source || '').toLowerCase();
    const sourceMakesClaim = sourceGuards.some((t) => lowerSource.includes(t.toLowerCase()));
    for (const term of forbidden) {
      if (target.includes(term) && !sourceMakesClaim) {
        critical.push({
          kind: 'claim-drift',
          detail: `Translation introduced the claim term "${term}" with no counterpart in the source.`,
          term,
        });
      }
    }
  }

  return {
    ok: critical.length === 0,
    critical,
    warnings,
    numbers: { source: srcNums, target: tgtNums },
  };
}
