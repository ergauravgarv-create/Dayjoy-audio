import { logger } from '../log.js';

const log = logger('asr:mock');

/**
 * A stand-in recogniser so the whole pipeline runs with no cloud account.
 *
 * It ignores the incoming audio and replays a scripted Dayjoy training on a
 * timer. The script is deliberately loaded with dosages, BV figures and brand
 * terms, because those are exactly what the validator and the glossary are
 * there to protect - a mock that only said "hello world" would let real bugs
 * through the tests.
 */
const SCRIPT = [
  'Namaskar sabhi distributors ko. Aaj hum Super Richberries product training start kar rahe hain.',
  'Sea Buckthorn ek powerful antioxidant rich berry hai.',
  'Iska ORAC value bahut high hai aur ye supports cellular protection.',
  'Recommended dosage 5 se 10 ml daily hai, subah khali pet.',
  'Ek bottle mein 500 ml product aata hai aur iska BV 1200 hai.',
  'Curind ke saath combine karne par results aur behtar hote hain.',
  'Dayjoy Fit90 program ke saath ye product 90 din tak lena hai.',
  'Haan.',
  'Theek hai.',
  'Koi bhi question ho to aap apni bhasha mein pooch sakte hain.',
];

export function createAsr(config) {
  let timer = null;
  let index = 0;
  let handlers = {};

  return {
    name: 'mock',

    start(h) {
      handlers = h;
      index = 0;
      const intervalMs = Number(process.env.MOCK_ASR_INTERVAL_MS || 4000);
      log.info('scripted recogniser started', { phrases: SCRIPT.length, intervalMs });
      timer = setInterval(() => {
        const text = SCRIPT[index % SCRIPT.length];
        index += 1;
        handlers.onPartial?.(text.slice(0, Math.ceil(text.length / 2)));
        handlers.onPhrase?.(text);
      }, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    },

    // The mock does not listen, but the trainer page still streams audio here
    // so the transport path is exercised exactly as it is in production.
    pushAudio() {},

    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      log.info('scripted recogniser stopped');
    },
  };
}
