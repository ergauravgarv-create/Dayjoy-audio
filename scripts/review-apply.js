/**
 * Merges a completed review sheet back into the glossary.
 *
 *   npm run review:apply review/te-glossary-review.csv
 *   npm run review:apply review/*.csv
 *
 * Nothing is written until every row parses, so a half-understood sheet cannot
 * leave the glossary in a mixed state. Run with --dry to see what would change.
 */

import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { loadConfig, ROOT } from '../src/config.js';
import { Glossary } from '../src/glossary.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/** Minimal RFC-4180 reader - enough for sheets round-tripped through Excel. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  const body = text.replace(/^﻿/, '');
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const files = args.filter((a) => !a.startsWith('--'));

if (!files.length) {
  console.error('\nUsage: npm run review:apply <file.csv> [more.csv] [--dry]\n');
  process.exit(1);
}

const config = await loadConfig();
const langs = config.translateChannels.map((c) => c.code);
const glossaryPath = join(ROOT, 'config', 'glossary.json');
const glossary = await Glossary.load(glossaryPath, langs);

const planned = [];
const problems = [];

for (const file of files) {
  const name = basename(file);
  const lang = name.split('-')[0];
  const channel = config.translateChannels.find((c) => c.code === lang);
  if (!channel) {
    problems.push(`${name}: filename must start with a language code (${langs.join(', ')})`);
    continue;
  }

  const rows = parseCsv(await readFile(file, 'utf8'));
  const headerIndex = rows.findIndex((r) => r[0] === 'English word');
  if (headerIndex === -1) {
    problems.push(`${name}: no header row - is this a Dayjoy review sheet?`);
    continue;
  }

  const nameRow = rows.find((r) => r[0] === 'Your name:');
  const reviewer = (nameRow?.[1] || '').trim();
  if (!reviewer) {
    problems.push(`${name}: the reviewer did not fill in "Your name:" - we cannot record who signed these off`);
    continue;
  }

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const [label, , , verdictRaw, correction, note, key] = rows[i];
    if (!key?.trim()) continue;

    const verdict = (verdictRaw || '').trim().toLowerCase();
    if (!verdict) continue; // left blank - still pending, which is honest

    const yes = ['yes', 'y', 'ok', 'correct', 'right', 'haan', 'sari', 'ho'].includes(verdict);
    const no = ['no', 'n', 'wrong', 'nahi', 'incorrect'].includes(verdict);

    if (!yes && !no) {
      problems.push(`${name} row ${i + 1} (${label}): "${verdictRaw}" is neither yes nor no`);
      continue;
    }
    if (!glossary.find(key.trim())) {
      problems.push(`${name} row ${i + 1} (${label}): unknown id "${key.trim()}" - was the id column edited?`);
      continue;
    }
    if (no && !(correction || '').trim()) {
      problems.push(`${name} row ${i + 1} (${label}): marked wrong but no correction was written`);
      continue;
    }

    planned.push({
      file: name,
      label,
      lang,
      key: key.trim(),
      status: yes ? 'approved' : 'corrected',
      spelling: (correction || '').trim(),
      by: reviewer,
      note: (note || '').trim(),
    });
  }
}

if (problems.length) {
  console.log(`\n${RED}Nothing was applied.${RESET} Fix these first:\n`);
  for (const p of problems) console.log(`  - ${p}`);
  console.log('');
  process.exit(1);
}

if (!planned.length) {
  console.log(`\n${YELLOW}No answered rows found.${RESET} The sheets came back blank.\n`);
  process.exit(0);
}

console.log('');
for (const p of planned) {
  const mark = p.status === 'approved' ? `${GREEN}approve${RESET}` : `${YELLOW}correct${RESET}`;
  const detail = p.status === 'corrected' ? ` -> ${p.spelling}` : '';
  console.log(`  ${mark}  ${p.lang}  ${p.label}${DIM}${detail}${RESET}`);
}

if (dryRun) {
  console.log(`\n${DIM}--dry: nothing written. ${planned.length} changes would be applied.${RESET}\n`);
  process.exit(0);
}

for (const p of planned) {
  await glossary.applyReview(glossaryPath, p);
}

const stillPending = glossary.pending(langs);
console.log(`\n${GREEN}Applied ${planned.length} decisions.${RESET}`);
console.log(
  stillPending.length
    ? `${YELLOW}${stillPending.length} (word, language) pairs still unreviewed.${RESET}\n`
    : `${GREEN}Every word is now reviewed in every language.${RESET}\n`
);
