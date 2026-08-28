import { logger } from './log.js';

const log = logger('backtranslate');

const SYSTEM = `You translate Indian-language health and product claims back into English so a regulatory reviewer who does not read the language can check them.

Translate LITERALLY, word for word where the grammar allows. This is the whole point of the task:

- Do NOT smooth the English out. Do NOT make it read well.
- Do NOT restore the wording you think the original English probably was.
- If the text says something stronger than a careful claim would - curing, treating, preventing disease - your English must say that just as strongly.
- If the text is vague or awkward, your English must be vague or awkward in the same way.

A fluent, tidied-up translation would hide exactly the drift the reviewer is looking for. Reproduce what is actually there.

Output only the English. No notes, no alternatives, no commentary.`;

/**
 * Turns a translated claim back into literal English.
 *
 * The regulatory reviewer signing off Odia almost certainly does not read Odia.
 * Without this they are approving text they cannot evaluate, which is worse than
 * no sign-off at all because it produces a paper trail suggesting someone
 * checked.
 */
export function createBackTranslator(config) {
  const { apiKey, model } = config.anthropic;
  const { translatorKey, translatorRegion, translatorEndpoint } = config.azure;

  async function viaClaude(text, channel) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        temperature: 0,
        system: SYSTEM,
        messages: [
          { role: 'user', content: `This is ${channel.name} (${channel.locale}). Translate it literally into English:\n\n${text}` },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const out = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!out) throw new Error('Empty back-translation');
    return { text: out, via: 'claude', literal: true };
  }

  async function viaAzure(text, channel) {
    const from = channel.azureTranslateCode || channel.code;
    const res = await fetch(`${translatorEndpoint}/translate?api-version=3.0&from=${from}&to=en`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Ocp-Apim-Subscription-Key': translatorKey,
        'Ocp-Apim-Subscription-Region': translatorRegion,
      },
      body: JSON.stringify([{ Text: text }]),
    });
    if (!res.ok) throw new Error(`Azure Translator ${res.status}`);
    const data = await res.json();
    const out = data?.[0]?.translations?.[0]?.text?.trim();
    if (!out) throw new Error('Empty back-translation');
    // Machine translation tidies as it goes, so this can read better than the
    // source actually does. The reviewer is told.
    return { text: out, via: 'azure', literal: false };
  }

  return {
    available: Boolean(apiKey || translatorKey),

    async run(text, channel) {
      if (!text?.trim()) return null;

      if (apiKey) {
        try {
          return await viaClaude(text, channel);
        } catch (err) {
          log.warn('literal back-translation failed, trying Azure', { err: err.message });
        }
      }
      if (translatorKey) return viaAzure(text, channel);

      throw new Error(
        'No back-translation available. Set ANTHROPIC_API_KEY or AZURE_TRANSLATOR_KEY - a reviewer must not sign off text they cannot read.'
      );
    },
  };
}
