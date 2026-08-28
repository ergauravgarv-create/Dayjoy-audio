/**
 * Indic digit normalisation.
 *
 * Translation models return numbers in whichever digit system suits the target
 * script - "5 ml" can legitimately come back as "౫ ml" in Telugu or "৫ ml" in
 * Bengali. Comparing those against the source as raw strings would report a
 * false mismatch on every single dosage, so every number is folded to ASCII
 * before the validator looks at it.
 */

const DIGIT_BLOCKS = [
  [0x0966, 'Devanagari'],
  [0x09e6, 'Bengali'],
  [0x0a66, 'Gurmukhi'],
  [0x0ae6, 'Gujarati'],
  [0x0b66, 'Oriya'],
  [0x0be6, 'Tamil'],
  [0x0c66, 'Telugu'],
  [0x0ce6, 'Kannada'],
  [0x0d66, 'Malayalam'],
];

/** Replace every Indic digit in `text` with its ASCII equivalent. */
export function normaliseDigits(text) {
  if (!text) return '';
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    let mapped = ch;
    for (const [base] of DIGIT_BLOCKS) {
      if (cp >= base && cp <= base + 9) {
        mapped = String(cp - base);
        break;
      }
    }
    out += mapped;
  }
  return out;
}

/** True if the text contains a digit in any supported script. */
export function hasDigits(text) {
  return /[0-9]/.test(normaliseDigits(text || ''));
}
