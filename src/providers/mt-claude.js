import { logger } from '../log.js';

const log = logger('mt:claude');

const SYSTEM = `You are the live interpreter for a Dayjoy product training. Dayjoy sells nutraceutical and wellness products in India through a distributor network.

The trainer speaks Hindi mixed freely with English (Hinglish). You translate each segment into the target language as it is spoken.

Rules, in order of importance:

1. NUMBERS ARE SACRED. Every quantity, dosage, price, duration, percentage and BV figure must appear in your translation exactly as in the source. "5 se 10 ml" stays five to ten millilitres - never 50, never rounded, never dropped. Use the same digits the source used.
2. NEVER STRENGTHEN A CLAIM. If the source says a product "supports" or "helps maintain" something, your translation must be equally hedged. Never introduce the ideas of curing, treating, preventing disease, or medicine. If the source did not make a medical claim, neither do you.
3. OBEY THE GLOSSARY. Terms listed below have a fixed approved wording. Use it exactly, character for character.
4. This is spoken audio for distributors, not a document. Use plain, natural, conversational language a listener understands the first time. Keep sentence order close to the source so the audio tracks the trainer's slides.
5. Keep it about the same length as the source. A longer translation makes the audio channel fall behind.

Output ONLY the translation. No preamble, no notes, no quotation marks, no romanisation, no alternatives.`;

export function createMt(config) {
  const { apiKey, model, maxTokens } = config.anthropic;
  if (!apiKey) throw new Error('MT_PROVIDER=claude needs ANTHROPIC_API_KEY in .env');

  return {
    name: 'claude',

    /**
     * @param {object} args
     * @param {string} args.text        Source segment.
     * @param {object} args.channel     Target channel definition.
     * @param {string[]} args.directives Glossary instructions for this segment.
     * @param {Array}  args.context     Recent {source, target} pairs for continuity.
     * @param {boolean} args.strict     Set on a retry after a validation failure.
     */
    async translate({ text, channel, directives = [], context = [], strict = false, signal }) {
      const parts = [];

      if (context.length) {
        parts.push(
          'Earlier in this training (for continuity of terminology only - do not re-translate):\n' +
            context.map((c) => `  ${c.source}\n  -> ${c.target}`).join('\n')
        );
      }

      if (directives.length) {
        parts.push('Approved wording for terms in this segment:\n' + directives.join('\n'));
      }

      if (strict) {
        parts.push(
          'A previous attempt failed validation. Re-translate with every digit from the source reproduced exactly, and no claim wording that the source did not contain.'
        );
      }

      parts.push(`Translate into ${channel.name} (${channel.locale}):\n${text}`);

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 0,
          system: SYSTEM,
          messages: [{ role: 'user', content: parts.join('\n\n') }],
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`);
      }

      const data = await res.json();
      const out = (data.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();

      if (!out) throw new Error('Anthropic returned an empty translation');
      log.debug('translated', { lang: channel.code, chars: out.length });
      return { text: out, provider: 'claude', model };
    },
  };
}
