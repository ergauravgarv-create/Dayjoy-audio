import { logger } from '../log.js';

const log = logger('asr:azure');

/**
 * Streaming recognition through Azure Speech.
 *
 * The locale is pinned to the primary source language rather than switching per
 * sentence. Trainers speak Hinglish - "Sea Buckthorn ek powerful antioxidant
 * rich berry hai" is one sentence, not two languages taking turns - and hi-IN
 * handles English loan-words inside Hindi far better than automatic locale
 * switching, which tends to thrash mid-utterance.
 *
 * The SDK is imported lazily so mock mode still runs on a machine where the
 * optional native dependency failed to install.
 */
export async function createAsr(config) {
  let sdk;
  try {
    sdk = await import('microsoft-cognitiveservices-speech-sdk');
  } catch (err) {
    throw new Error(
      'ASR_PROVIDER=azure needs the speech SDK. Run: npm install microsoft-cognitiveservices-speech-sdk'
    );
  }

  const { speechKey, speechRegion } = config.azure;
  if (!speechKey) throw new Error('ASR_PROVIDER=azure needs AZURE_SPEECH_KEY in .env');

  let recognizer = null;
  let pushStream = null;

  return {
    name: 'azure',

    start(handlers) {
      const speechConfig = sdk.SpeechConfig.fromSubscription(speechKey, speechRegion);
      speechConfig.speechRecognitionLanguage = config.languages.source.primary;
      speechConfig.outputFormat = sdk.OutputFormat.Simple;

      // How much silence ends a phrase. This is the segment-wait line in the
      // latency budget - lower it and segments arrive sooner but get chopped
      // mid-clause; raise it and the channel lags.
      const silence = String(config.segmenter.endSilenceMs);
      for (const prop of [
        sdk.PropertyId?.Speech_SegmentationSilenceTimeoutMs,
        sdk.PropertyId?.SpeechServiceConnection_EndSilenceTimeoutMs,
      ]) {
        if (prop !== undefined) {
          try {
            speechConfig.setProperty(prop, silence);
          } catch {
            /* older SDKs do not expose every property; the default is workable */
          }
        }
      }

      const format = sdk.AudioStreamFormat.getWaveFormatPCM(config.audio.inputSampleRate, 16, 1);
      pushStream = sdk.AudioInputStream.createPushStream(format);
      const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
      recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

      recognizer.recognizing = (_s, e) => {
        if (e.result?.text) handlers.onPartial?.(e.result.text);
      };

      recognizer.recognized = (_s, e) => {
        if (e.result?.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) {
          handlers.onPhrase?.(e.result.text);
        }
      };

      recognizer.canceled = (_s, e) => {
        log.error('recognition cancelled', { reason: e.reason, detail: e.errorDetails || '' });
        handlers.onError?.(new Error(e.errorDetails || 'recognition cancelled'));
      };

      recognizer.sessionStopped = () => log.info('recognition session stopped');

      recognizer.startContinuousRecognitionAsync(
        () => log.info('recognition started', { locale: speechConfig.speechRecognitionLanguage, silenceMs: silence }),
        (err) => {
          log.error('failed to start recognition', { err: String(err) });
          handlers.onError?.(new Error(String(err)));
        }
      );
    },

    /** @param {Buffer} chunk 16-bit little-endian PCM at the configured sample rate. */
    pushAudio(chunk) {
      if (!pushStream) return;
      pushStream.write(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
    },

    async stop() {
      if (!recognizer) return;
      await new Promise((resolve) => {
        recognizer.stopContinuousRecognitionAsync(resolve, resolve);
      });
      try {
        pushStream?.close();
        recognizer.close();
      } catch {
        /* already torn down */
      }
      recognizer = null;
      pushStream = null;
    },
  };
}
