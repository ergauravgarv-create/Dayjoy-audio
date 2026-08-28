/**
 * A stand-in voice engine. It writes a real, decodable WAV whose length matches
 * how long the sentence would actually take to say, so timing, queue drift,
 * recording and browser playback can all be exercised without a cloud account.
 *
 * It is a soft two-tone warble, not speech - useful for testing, useless for
 * judging quality. Every quality decision needs the real engine.
 */

const SAMPLE_RATE = 16000;

// Roughly the pace of an Indian-language neural voice at rate 1.0.
const CHARS_PER_SECOND = 13;

function writeWavHeader(pcmBytes) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcmBytes, 40);
  return header;
}

export function createTts() {
  return {
    name: 'mock',

    async synthesise({ text, rate = 1.0 }) {
      const seconds = Math.min(30, Math.max(0.4, text.length / CHARS_PER_SECOND / rate));
      const samples = Math.floor(seconds * SAMPLE_RATE);
      const pcm = Buffer.alloc(samples * 2);

      for (let i = 0; i < samples; i++) {
        const t = i / SAMPLE_RATE;
        // Two close tones plus a slow envelope, so segment boundaries are audible.
        const carrier = Math.sin(2 * Math.PI * 210 * t) * 0.5 + Math.sin(2 * Math.PI * 320 * t) * 0.25;
        const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 3.2 * t);
        const fadeIn = Math.min(1, t / 0.04);
        const fadeOut = Math.min(1, (seconds - t) / 0.06);
        const value = carrier * syllable * fadeIn * fadeOut * 0.22;
        pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), i * 2);
      }

      return {
        audio: Buffer.concat([writeWavHeader(pcm.length), pcm]),
        mime: 'audio/wav',
        durationMs: Math.round(seconds * 1000),
      };
    },
  };
}
