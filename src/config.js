import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..');

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export async function loadConfig() {
  const languages = JSON.parse(await readFile(join(ROOT, 'config', 'languages.json'), 'utf8'));

  return {
    port: num(process.env.PORT, 8080),
    host: process.env.HOST || '0.0.0.0',
    publicUrl: process.env.PUBLIC_URL || '',

    trainerKey: process.env.TRAINER_KEY || 'dayjoy-trainer',
    adminKey: process.env.ADMIN_KEY || 'dayjoy-admin',
    // Handed to native-speaker reviewers, who are not staff and should not get
    // a key that also opens the trainer console.
    reviewKey: process.env.REVIEW_KEY || 'dayjoy-review',
    // The regulatory reviewer. A separate person answering a separate question,
    // so a separate key.
    complianceKey: process.env.COMPLIANCE_KEY || 'dayjoy-compliance',

    // On by default, and it should stay on. A health claim that has not been
    // signed off is not spoken - the segment goes out as a caption and the
    // trainer is told to say it themselves.
    requireClaimSignoff: bool(process.env.REQUIRE_CLAIM_SIGNOFF, true),

    providers: {
      asr: process.env.ASR_PROVIDER || 'mock',
      mt: process.env.MT_PROVIDER || 'mock',
      tts: process.env.TTS_PROVIDER || 'mock',
    },

    azure: {
      speechKey: process.env.AZURE_SPEECH_KEY || '',
      speechRegion: process.env.AZURE_SPEECH_REGION || 'centralindia',
      translatorKey: process.env.AZURE_TRANSLATOR_KEY || '',
      translatorRegion: process.env.AZURE_TRANSLATOR_REGION || 'centralindia',
      translatorEndpoint:
        process.env.AZURE_TRANSLATOR_ENDPOINT || 'https://api.cognitive.microsofttranslator.com',
    },

    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
      maxTokens: num(process.env.ANTHROPIC_MAX_TOKENS, 1024),
    },

    audio: {
      // 16 kHz / 32 kbps mono MP3 is about 14 MB per hour of continuous speech,
      // which lands near 10 MB across a real session once pauses are counted.
      // Switch to audio-24khz-48kbitrate-mono-mp3 for a richer voice at ~21 MB/hr.
      outputFormat: process.env.AUDIO_FORMAT || 'audio-16khz-32kbitrate-mono-mp3',
      bitrateKbps: num(process.env.AUDIO_BITRATE_KBPS, 32),
      inputSampleRate: 16000,
    },

    segmenter: {
      minWordsStandalone: num(process.env.SEG_MIN_WORDS, 3),
      coalesceWindowMs: num(process.env.SEG_COALESCE_MS, 1200),
      maxSegmentChars: num(process.env.SEG_MAX_CHARS, 320),
      maxSegmentMs: num(process.env.SEG_MAX_MS, 12000),
      endSilenceMs: num(process.env.SEG_END_SILENCE_MS, 600),
    },

    drift: {
      dropThresholdMs: num(process.env.DRIFT_DROP_MS, 15000),
    },

    recording: {
      enabled: bool(process.env.RECORDING_ENABLED, true),
      dir: process.env.RECORDING_DIR || join(ROOT, 'data', 'recordings'),
      retentionDays: num(process.env.RECORDING_RETENTION_DAYS, 365),
    },

    // Held-back broadcast so translated audio does not arrive before the Zoom
    // video it is describing. Set per session from the trainer console.
    defaultAlignmentDelayMs: num(process.env.ALIGNMENT_DELAY_MS, 0),

    // Off by default: a language nobody is listening to is not translated or
    // spoken, which is most of the per-session saving. Turn it on when you want
    // every language archived regardless of who attended live.
    translateAllChannels: bool(process.env.TRANSLATE_ALL_CHANNELS, false),
    alwaysOnLangs: (process.env.ALWAYS_ON_LANGS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    languages,
    channels: languages.channels,
    translateChannels: languages.channels.filter((c) => c.mode === 'translate'),
  };
}
