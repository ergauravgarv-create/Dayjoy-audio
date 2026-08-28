import { logger } from '../log.js';
import { rateToSsml } from '../drift.js';

const log = logger('tts:azure');

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Azure neural voices over the REST endpoint - no SDK needed for synthesis.
 *
 * The speech rate arrives from the drift controller. Asking the engine itself to
 * speak faster keeps the voice natural; speeding the audio up in the browser
 * would raise the pitch and sound wrong.
 */
export function createTts(config) {
  const { speechKey, speechRegion } = config.azure;
  if (!speechKey) throw new Error('TTS_PROVIDER=azure needs AZURE_SPEECH_KEY in .env');

  const endpoint = `https://${speechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const format = config.audio.outputFormat;
  const bitrate = config.audio.bitrateKbps;

  return {
    name: 'azure',

    async synthesise({ text, channel, rate = 1.0, signal }) {
      const voice = process.env[`VOICE_${channel.code.toUpperCase()}`] || channel.voice;
      if (!voice) throw new Error(`No voice configured for channel "${channel.code}"`);

      const ssml =
        `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${channel.locale}">` +
        `<voice name="${voice}">` +
        `<prosody rate="${rateToSsml(rate)}">${escapeXml(text)}</prosody>` +
        `</voice></speak>`;

      const res = await fetch(endpoint, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': format,
          'Ocp-Apim-Subscription-Key': speechKey,
          'User-Agent': 'dayjoy-audio',
        },
        body: ssml,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Azure TTS ${res.status}: ${body.slice(0, 300)}`);
      }

      const audio = Buffer.from(await res.arrayBuffer());

      // Constant-bitrate MP3, so bytes map cleanly onto duration. The drift
      // controller only needs this accurate to within a few tens of milliseconds.
      const durationMs = Math.round((audio.length * 8) / bitrate);

      log.debug('synthesised', { lang: channel.code, voice, bytes: audio.length, durationMs, rate });
      return { audio, mime: 'audio/mpeg', durationMs, voice };
    },
  };
}
