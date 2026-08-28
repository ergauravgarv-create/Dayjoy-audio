/**
 * The audit record: every claim, every language, who approved what and when.
 *
 *   npm run compliance:report
 *
 * Writes review/compliance-report.md. This is the artefact to keep on file - if
 * a claim is ever questioned, it shows what wording was authorised, in which
 * language, on whose authority, and on what basis.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, ROOT } from '../src/config.js';
import { Glossary } from '../src/glossary.js';

const config = await loadConfig();
const langs = config.translateChannels.map((c) => c.code);
const glossary = await Glossary.load(join(ROOT, 'config', 'glossary.json'), langs);

const when = (r) => (r?.at ? new Date(r.at).toISOString().slice(0, 10) : '—');
const who = (r) => (r?.by && r.by !== 'system' ? r.by : '—');

const lines = [
  '# Dayjoy claim compliance record',
  '',
  `Glossary version **${glossary.version}**. Generated from \`config/glossary.json\`.`,
  '',
  'Every claim carries two independent sign-offs: whether it may be made at all,',
  'and whether each translation is still that same claim and no stronger. A claim',
  'is only spoken in a language when both have passed and a native speaker has',
  'checked the wording.',
  '',
];

let blocked = 0;
let cleared = 0;

for (const claim of glossary.claims) {
  const master = glossary.masterCompliance(claim);
  lines.push(`## "${claim.source}"`, '');

  if (master.status === 'approved') {
    lines.push(`**Permissible** — approved by ${who(master)} on ${when(master)}.`);
    if (master.basis) lines.push(`Basis: ${master.basis}`);
  } else if (master.status === 'rejected') {
    lines.push(`**Not permissible** — rejected by ${who(master)} on ${when(master)}. This claim is not spoken in any language.`);
  } else {
    lines.push('**Not yet decided.** Until it is, this claim is not spoken in any language.');
  }
  lines.push('');

  lines.push('| Language | Wording | Back-translation seen by reviewer | Compliance | Language check | Spoken? |');
  lines.push('|---|---|---|---|---|---|');

  for (const channel of config.translateChannels) {
    const compliance = glossary.complianceOf(claim, channel.code);
    const language = glossary.reviewOf(claim, channel.code);
    const status = glossary.claimStatus(claim, channel.code);
    if (status.usable) cleared += 1;
    else blocked += 1;

    const complianceCell =
      compliance.status === 'approved'
        ? `approved — ${who(compliance)}, ${when(compliance)}`
        : compliance.status === 'rejected'
          ? `**rejected** — ${who(compliance)}, ${when(compliance)}`
          : compliance.by === 'system'
            ? 'reset — wording changed after approval'
            : 'pending';

    const languageCell =
      language.status === 'pending' ? 'pending' : `${language.status} — ${who(language)}, ${when(language)}`;

    lines.push(
      `| ${channel.name} | ${claim.approved?.[channel.code] || '—'} | ${compliance.backTranslation || '—'} | ${complianceCell} | ${languageCell} | ${status.usable ? 'yes' : 'no'} |`
    );
  }

  lines.push('');
  const notes = config.translateChannels
    .map((c) => ({ c, r: glossary.complianceOf(claim, c.code) }))
    .filter(({ r }) => r.note);
  if (notes.length) {
    lines.push('Reviewer notes:');
    for (const { c, r } of notes) lines.push(`- **${c.name}** — ${r.note}`);
    lines.push('');
  }
}

lines.push('---', '');
lines.push(`**${cleared}** claim/language pairs cleared to be spoken. **${blocked}** are not.`);
lines.push('');
lines.push(
  config.requireClaimSignoff
    ? 'Enforcement is **on**: an uncleared claim is never spoken. The sentence reaches listeners as a caption and the trainer is prompted to make the point themselves.'
    : '> **Enforcement is OFF.** `REQUIRE_CLAIM_SIGNOFF=false` means uncleared claims are still spoken. Turn this on before any real training.'
);
lines.push('');

const dir = join(ROOT, 'review');
await mkdir(dir, { recursive: true });
const file = join(dir, 'compliance-report.md');
await writeFile(file, lines.join('\n'), 'utf8');

console.log(`\n  Written to review/compliance-report.md`);
console.log(`  ${cleared} claim/language pairs cleared, ${blocked} blocked`);
if (!config.requireClaimSignoff) {
  console.log(`\n  WARNING: REQUIRE_CLAIM_SIGNOFF is off - uncleared claims are still being spoken.`);
}
console.log('');
