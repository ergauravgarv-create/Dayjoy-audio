/**
 * Preflight - proves your cloud keys work before a training does it for you,
 * and produces voice samples for a native speaker to choose from.
 *
 *   npm run preflight
 *
 * Checks every configured provider, then synthesises the same Dayjoy sentence
 * in both the female and male voice of every language and writes them to
 * ./samples/. Play those to a native speaker of each language and pick the one
 * that sounds like a trainer rather than an announcer - that choice cannot be
 * made from a datasheet, and it is the single cheapest quality win available.
 *
 * Exits non-zero if anything a live session depends on is broken.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, ROOT } from '../src/config.js';
import { Glossary } from '../src/glossary.js';

// Deliberately loaded: a dosage range, a BV figure, two brand terms and a hedged
// claim. If a provider mangles this sentence it will mangle a real training.
const PROBE =
  'Super Richberries ek powerful antioxidant hai. Recommended dosage 5 se 10 ml daily hai aur iska BV 1200 hai.';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const results = [];

function record(area, name, ok, detail) {
  results.push({ area, name, ok, detail });
  const mark = ok === true ? `${GREEN}PASS${RESET}` : ok === null ? `${YELLOW}SKIP${RESET}` : `${RED}FAIL${RESET}`;
  console.log(`  ${mark}  ${name}${detail ? `  ${DIM}${detail}${RESET}` : ''}`);
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function checkSpeechKey(config) {
  const { speechKey, speechRegion } = config.azure;
  if (!speechKey) {
    record('asr', 'Azure Speech key', null, 'AZURE_SPEECH_KEY not set');
    return false;
  }
  try {
    const res = await fetch(`https://${speechRegion}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': speechKey, 'content-length': '0' },
    });
    if (!res.ok) {
      record('asr', 'Azure Speech key', false, `HTTP ${res.status} from ${speechRegion}`);
      return false;
    }
    const token = await res.text();
    record('asr', 'Azure Speech key', true, `${speechRegion}, token ${token.length} chars`);
    return true;
  } catch (err) {
    record('asr', 'Azure Speech key', false, err.message);
    return false;
  }
}

async function checkSpeechSdk() {
  try {
    await import('microsoft-cognitiveservices-speech-sdk');
    record('asr', 'Speech SDK installed', true, 'streaming recognition available');
    return true;
  } catch {
    record('asr', 'Speech SDK installed', false, 'run: npm install microsoft-cognitiveservices-speech-sdk');
    return false;
  }
}

async function checkTranslator(config) {
  const { translatorKey, translatorRegion, translatorEndpoint } = config.azure;
  if (!translatorKey) {
    record('mt', 'Azure Translator', null, 'AZURE_TRANSLATOR_KEY not set - no fallback translator');
    return;
  }
  const to = config.translateChannels.map((c) => c.azureTranslateCode || c.code).join(',');
  try {
    const res = await fetch(`${translatorEndpoint}/translate?api-version=3.0&from=hi&to=${to}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Ocp-Apim-Subscription-Key': translatorKey,
        'Ocp-Apim-Subscription-Region': translatorRegion,
      },
      body: JSON.stringify([{ Text: PROBE }]),
    });
    if (!res.ok) {
      record('mt', 'Azure Translator', false, `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
      return;
    }
    const data = await res.json();
    const got = (data?.[0]?.translations || []).map((t) => t.to);
    const missing = config.translateChannels
      .map((c) => c.azureTranslateCode || c.code)
      .filter((code) => !got.includes(code));
    record('mt', 'Azure Translator', missing.length === 0, missing.length ? `no output for: ${missing.join(', ')}` : `${got.length} languages`);
  } catch (err) {
    record('mt', 'Azure Translator', false, err.message);
  }
}

async function checkClaude(config, glossary) {
  const { apiKey, model } = config.anthropic;
  if (!apiKey) {
    record('mt', 'Anthropic', null, 'ANTHROPIC_API_KEY not set');
    return;
  }
  try {
    const { createMt } = await import('../src/providers/mt-claude.js');
    const mt = createMt(config);
    const channel = config.translateChannels.find((c) => c.code === 'te') || config.translateChannels[0];
    const matches = glossary.detect(PROBE);
    const started = Date.now();
    const out = await mt.translate({
      text: PROBE,
      channel,
      directives: glossary.directives(matches, channel.code),
      context: [],
    });
    const ms = Date.now() - started;

    // The one thing worth asserting automatically: the dosage survived.
    const kept = ['5', '10', '1200'].filter((n) => out.text.includes(n));
    const ok = kept.length === 3;
    record(
      'mt',
      `Anthropic (${model})`,
      ok,
      ok ? `${ms} ms, dosage preserved` : `${ms} ms, MISSING figures: ${['5', '10', '1200'].filter((n) => !kept.includes(n)).join(', ')}`
    );
    console.log(`        ${DIM}${channel.name}: ${out.text.slice(0, 110)}${RESET}`);
  } catch (err) {
    record('mt', 'Anthropic', false, err.message);
  }
}

async function checkVoices(config) {
  const { speechKey, speechRegion } = config.azure;
  if (!speechKey) {
    record('tts', 'Neural voices', null, 'AZURE_SPEECH_KEY not set');
    return;
  }

  const dir = join(ROOT, 'samples');
  await mkdir(dir, { recursive: true });
  const endpoint = `https://${speechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`;
  let failures = 0;

  for (const channel of config.translateChannels) {
    for (const [role, voice] of [['a', channel.voice], ['b', channel.voiceAlt]]) {
      if (!voice) continue;
      const ssml =
        `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${channel.locale}">` +
        `<voice name="${voice}"><prosody rate="0%">${escapeXml(PROBE)}</prosody></voice></speak>`;
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': config.audio.outputFormat,
            'Ocp-Apim-Subscription-Key': speechKey,
            'User-Agent': 'dayjoy-preflight',
          },
          body: ssml,
        });
        if (!res.ok) {
          failures += 1;
          record('tts', `${channel.name} / ${voice}`, false, `HTTP ${res.status}: ${(await res.text()).slice(0, 90)}`);
          continue;
        }
        const audio = Buffer.from(await res.arrayBuffer());
        const seconds = (audio.length * 8) / config.audio.bitrateKbps / 1000;
        const file = `${channel.code}-${role}-${voice}.mp3`;
        await writeFile(join(dir, file), audio);
        record('tts', `${channel.name} / ${voice}`, true, `${(audio.length / 1024).toFixed(0)} kB, ${seconds.toFixed(1)}s -> samples/${file}`);
      } catch (err) {
        failures += 1;
        record('tts', `${channel.name} / ${voice}`, false, err.message);
      }
    }
  }

  if (!failures) {
    console.log(`\n  ${DIM}Voice samples written to ./samples - play each pair to a native speaker`);
    console.log(`  and set VOICE_<CODE> in .env to whichever sounds like a trainer.${RESET}`);
  }
}

function checkGlossary(glossary, config) {
  const langs = config.translateChannels.map((c) => c.code);
  const pending = glossary.pending(langs);
  const byLang = {};
  for (const p of pending) byLang[p.lang] = (byLang[p.lang] || 0) + 1;
  const summary = Object.entries(byLang)
    .map(([l, n]) => `${l}:${n}`)
    .join(' ');

  record(
    'glossary',
    'Native-speaker review',
    pending.length === 0,
    pending.length
      ? `${pending.length} word/language pairs unreviewed (${summary}) - run: npm run review:sheet`
      : 'every word signed off in every language'
  );

  // Claims carry a second, independent sign-off. A native speaker confirms the
  // wording reads naturally; only a regulatory reviewer can say it is allowed.
  const pendingClaims = glossary.pendingCompliance(langs);
  const rejected = [];
  for (const claim of glossary.claims) {
    for (const l of langs) {
      if (glossary.complianceOf(claim, l).status === 'rejected') rejected.push(`${claim.source} (${l})`);
    }
  }

  record(
    'glossary',
    'Claim compliance sign-off',
    pendingClaims.length === 0,
    pendingClaims.length
      ? `${pendingClaims.length} claim decisions outstanding - send the reviewer /compliance?key=<COMPLIANCE_KEY>`
      : 'every claim ruled on in every language'
  );

  if (rejected.length) {
    record('glossary', 'Rejected claims', null, `${rejected.length} will not be spoken: ${rejected.slice(0, 3).join(', ')}`);
  }

  if (!config.requireClaimSignoff) {
    record(
      'glossary',
      'Claim enforcement',
      false,
      'REQUIRE_CLAIM_SIGNOFF is off - unapproved health claims will be spoken aloud'
    );
  }

  // A brand term with no spelling for a language will be read out in Latin
  // letters by that language's voice, which mispronounces or skips it.
  const gaps = [];
  for (const term of glossary.terms) {
    if (term.policy !== 'keep') continue;
    for (const code of ['te', 'kn', 'or', 'bn', 'ta', 'en']) {
      if (!term.say?.[code]) gaps.push(`${term.term}/${code}`);
    }
  }
  record('glossary', 'Per-language spellings', gaps.length === 0, gaps.length ? `missing: ${gaps.slice(0, 8).join(', ')}` : 'every protected term has a spelling in every language');
}

async function main() {
  const config = await loadConfig();
  const glossary = await Glossary.load(
    join(ROOT, 'config', 'glossary.json'),
    config.translateChannels.map((c) => c.code)
  );

  console.log(`\nDayjoy preflight  ${DIM}asr=${config.providers.asr} mt=${config.providers.mt} tts=${config.providers.tts}${RESET}\n`);

  console.log('Recognition');
  await checkSpeechSdk();
  await checkSpeechKey(config);

  console.log('\nTranslation');
  await checkClaude(config, glossary);
  await checkTranslator(config);

  console.log('\nVoices');
  await checkVoices(config);

  console.log('\nGlossary');
  checkGlossary(glossary, config);

  const failed = results.filter((r) => r.ok === false);
  const skipped = results.filter((r) => r.ok === null);

  console.log(`\n${'-'.repeat(62)}`);
  console.log(
    `${results.filter((r) => r.ok === true).length} passed, ` +
      `${failed.length} failed, ${skipped.length} not configured\n`
  );

  if (failed.length) {
    console.log(`${RED}Not ready for a live training.${RESET} Fix the failures above.\n`);
    process.exit(1);
  }
  if (skipped.length) {
    console.log(`${YELLOW}Ready, with gaps.${RESET} Unconfigured providers fall back to mocks.\n`);
  } else {
    console.log(`${GREEN}Ready for a live training.${RESET}\n`);
  }
}

main().catch((err) => {
  console.error(`\n${RED}Preflight crashed:${RESET} ${err.stack}\n`);
  process.exit(1);
});
