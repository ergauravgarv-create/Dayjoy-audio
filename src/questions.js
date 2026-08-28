import { randomUUID } from 'node:crypto';
import { logger } from './log.js';

const log = logger('questions');

const MAX_CHARS = 500;
const MAX_PER_WINDOW = 5;
const WINDOW_MS = 60000;
const MAX_QUEUE = 300;

const SYSTEM = `You translate questions from Dayjoy distributors so a trainer can read and answer them out loud.

The trainer speaks Hindi and English. Give both renderings:
- "hi": natural spoken Hindi in Devanagari.
- "en": plain English.

Rules:
- Keep it a question. Do not answer it, do not soften it, do not add politeness the writer did not use.
- Dayjoy brand terms (Dayjoy, Curind, Super Richberries, Sea Buckthorn, ORAC, BV, Fit90) must come back in their normal Latin spelling so the trainer recognises them instantly.
- Preserve every number, dosage and quantity exactly.
- If the text is unclear or too garbled to translate, return it as-is rather than guessing what they meant.

Reply with only a JSON object: {"hi": "...", "en": "..."}`;

/**
 * Turns a typed question into something the trainer can read aloud.
 *
 * Text rather than voice is the whole point: a distributor typing a question has
 * chosen to send it, which is a very different thing from capturing their voice
 * out of a meeting, and it needs no microphone on a distributor's phone.
 */
export function createQuestionTranslator(config, providers) {
  const { apiKey, model } = config.anthropic;

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
        max_tokens: 600,
        temperature: 0,
        system: SYSTEM,
        messages: [
          { role: 'user', content: `This question is in ${channel.name} (${channel.locale}):\n\n${text}` },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const data = await res.json();
    const raw = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    const parsed = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim());
    if (!parsed.hi && !parsed.en) throw new Error('Empty translation');
    return { hi: parsed.hi || '', en: parsed.en || '', via: 'claude' };
  }

  async function viaAzure(text, channel) {
    const { translatorKey, translatorRegion, translatorEndpoint } = config.azure;
    const from = channel.azureTranslateCode || channel.code;
    const res = await fetch(`${translatorEndpoint}/translate?api-version=3.0&from=${from}&to=hi&to=en`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Ocp-Apim-Subscription-Key': translatorKey,
        'Ocp-Apim-Subscription-Region': translatorRegion,
      },
      body: JSON.stringify([{ Text: text }]),
    });
    if (!res.ok) throw new Error(`Azure Translator ${res.status}`);
    const out = (await res.json())?.[0]?.translations || [];
    return {
      hi: out.find((t) => t.to === 'hi')?.text || '',
      en: out.find((t) => t.to === 'en')?.text || '',
      via: 'azure',
    };
  }

  return {
    async translate({ text, channel }) {
      // A question typed in the trainer's own languages needs no translation.
      if (channel.code === 'en') return { hi: '', en: text, via: 'none' };
      if (channel.code === 'hi') return { hi: text, en: '', via: 'none' };

      if (apiKey) {
        try {
          return await viaClaude(text, channel);
        } catch (err) {
          log.warn('question translation failed, trying fallback', { err: err.message });
        }
      }
      if (config.azure.translatorKey) {
        try {
          return await viaAzure(text, channel);
        } catch (err) {
          log.warn('fallback question translation failed', { err: err.message });
        }
      }
      // Better the trainer sees the original than nothing at all.
      return { hi: '', en: '', via: 'none', untranslated: true };
    },
  };
}

/**
 * The queue of questions waiting for the trainer.
 *
 * Questions are held per session and archived with the recording, because "what
 * did distributors actually ask" is one of the more useful things a training
 * produces and it is lost the moment the session ends.
 */
export class QuestionBoard {
  constructor({ translator, onQuestion }) {
    this.translator = translator;
    this.onQuestion = onQuestion || (() => {});
    this.questions = [];
    this.rate = new Map(); // ws -> timestamps
  }

  reset() {
    this.questions = [];
    this.rate.clear();
  }

  /** Simple flood guard: a room of 600 needs one, and it needs no more than this. */
  #allowed(key, now) {
    const hits = (this.rate.get(key) || []).filter((t) => now - t < WINDOW_MS);
    if (hits.length >= MAX_PER_WINDOW) return false;
    hits.push(now);
    this.rate.set(key, hits);
    return true;
  }

  async submit({ text, channel, askedBy, key }) {
    const clean = String(text || '').trim().slice(0, MAX_CHARS);
    if (!clean) throw new Error('Please type a question first.');
    if (!this.#allowed(key, Date.now())) {
      throw new Error('You have sent several questions already. Please wait a minute before sending another.');
    }

    const question = {
      id: randomUUID().slice(0, 8),
      at: new Date().toISOString(),
      lang: channel.code,
      langName: channel.name,
      original: clean,
      askedBy: String(askedBy || '').trim().slice(0, 40),
      hi: '',
      en: '',
      answered: false,
    };

    this.questions.push(question);
    if (this.questions.length > MAX_QUEUE) this.questions.shift();

    // Show it to the trainer immediately in the original, then fill in the
    // translation - a question that appears two seconds late is still useful,
    // one that never appears because translation failed is not.
    this.onQuestion(question);

    try {
      const t = await this.translator.translate({ text: clean, channel });
      question.hi = t.hi;
      question.en = t.en;
      question.via = t.via;
    } catch (err) {
      log.error('question translation failed', { err: err.message });
    }

    this.onQuestion(question);
    log.info('question received', { lang: question.lang, chars: clean.length });
    return question;
  }

  markAnswered(id, answered = true) {
    const q = this.questions.find((x) => x.id === id);
    if (q) {
      q.answered = answered;
      this.onQuestion(q);
    }
    return q || null;
  }

  list() {
    return this.questions;
  }

  pendingCount() {
    return this.questions.filter((q) => !q.answered).length;
  }
}
