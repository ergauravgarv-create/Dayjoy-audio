/**
 * Generates one review sheet per language for reviewers who would rather work
 * in Google Sheets than in a browser tab.
 *
 *   npm run review:sheet
 *
 * Writes review/<lang>-glossary-review.csv. Send the file to a native speaker,
 * have them fill the two answer columns, and feed it back with:
 *
 *   npm run review:apply review/te-glossary-review.csv
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, ROOT } from '../src/config.js';
import { Glossary, entryKey, spellingField } from '../src/glossary.js';

const HELP = {
  keep: 'Brand name - never translated, only written in your script so the voice says it correctly',
  render: 'Common word - we want one agreed translation used in every training',
  claim: 'Health statement - must not be made stronger than the original',
};

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  // Excel only reads UTF-8 CSV as Unicode if it starts with a byte-order mark.
  // Without it, every Telugu and Odia cell opens as mojibake and the reviewer
  // assumes the file is broken.
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const config = await loadConfig();
const langs = config.translateChannels.map((c) => c.code);
const glossary = await Glossary.load(join(ROOT, 'config', 'glossary.json'), langs);

const dir = join(ROOT, 'review');
await mkdir(dir, { recursive: true });

for (const channel of config.translateChannels) {
  const rows = [
    ['Dayjoy glossary review', channel.name, channel.native],
    [],
    ['Your name:', '', '<- please fill this in'],
    [],
    [
      'English word',
      'What it is',
      'We wrote it like this',
      'Is it right? (yes / no)',
      'If no, write it correctly here',
      'Notes (optional)',
      'id (do not change)',
    ],
  ];

  for (const entry of glossary.entries) {
    const field = spellingField(entry);
    const review = glossary.reviewOf(entry, channel.code);
    rows.push([
      entry.term || entry.source,
      HELP[entry.source ? 'claim' : entry.policy] || HELP.render,
      entry[field]?.[channel.code] || '',
      review.status === 'pending' ? '' : review.status === 'approved' ? 'yes' : 'no',
      '',
      review.note || '',
      entryKey(entry),
    ]);
  }

  const file = join(dir, `${channel.code}-glossary-review.csv`);
  await writeFile(file, toCsv(rows), 'utf8');
  console.log(`  ${channel.native.padEnd(10)} ${channel.name.padEnd(9)} -> review/${channel.code}-glossary-review.csv  (${glossary.entries.length} words)`);
}

await writeFile(
  join(dir, 'README.txt'),
  [
    'Dayjoy glossary review',
    '======================',
    '',
    'Our product trainings are translated automatically so distributors can',
    'listen in their own language. A computer voice reads the words aloud.',
    '',
    'We have written our product names in your language, but we guessed.',
    'Please check each one.',
    '',
    'For each row:',
    '  - If the spelling is right, write "yes" in the "Is it right?" column.',
    '  - If it is wrong, write "no" and put the correct spelling in the next column.',
    '',
    'Two things to keep in mind:',
    '  - Brand names (Dayjoy, Curind, Super Richberries) must NOT be translated.',
    '    We only want them written in your script so the voice pronounces them',
    '    correctly. Write what it should SOUND like.',
    '  - Health statements must not be made stronger. If the English says a',
    '    product "supports" something, the translation must be equally careful.',
    '    Never write that anything cures or treats a disease.',
    '',
    'Please do not change the last column (id) - we need it to match your',
    'answers back to the right word.',
    '',
    'Send the completed file back to Dayjoy. Thank you.',
  ].join('\n'),
  'utf8'
);

console.log(`\n  Instructions for reviewers written to review/README.txt`);
console.log(`  Send each reviewer their language's file plus that README.\n`);
