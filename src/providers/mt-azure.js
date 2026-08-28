import { logger } from '../log.js';

const log = logger('mt:azure');

/**
 * Azure Translator. Fast and cheap, and the right thing to fall back to when
 * the primary translator times out - a slightly blunter Telugu sentence beats a
 * silent channel.
 *
 * It takes no glossary instructions, so brand terms are corrected afterwards by
 * the glossary's enforcement step rather than during translation.
 */
export function createMt(config) {
  const { translatorKey, translatorRegion, translatorEndpoint } = config.azure;
  if (!translatorKey) throw new Error('MT_PROVIDER=azure needs AZURE_TRANSLATOR_KEY in .env');

  const from = (config.languages.source.primary || 'hi-IN').split('-')[0];

  return {
    name: 'azure',

    async translate({ text, channel, signal }) {
      const to = channel.azureTranslateCode || channel.code;
      const url = `${translatorEndpoint}/translate?api-version=3.0&from=${from}&to=${to}&textType=plain`;

      const res = await fetch(url, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'Ocp-Apim-Subscription-Key': translatorKey,
          'Ocp-Apim-Subscription-Region': translatorRegion,
        },
        body: JSON.stringify([{ Text: text }]),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Azure Translator ${res.status}: ${body.slice(0, 300)}`);
      }

      const data = await res.json();
      const out = data?.[0]?.translations?.[0]?.text?.trim();
      if (!out) throw new Error('Azure Translator returned an empty translation');

      log.debug('translated', { lang: channel.code, chars: out.length });
      return { text: out, provider: 'azure' };
    },
  };
}
