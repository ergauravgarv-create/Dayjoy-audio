import { logger } from '../log.js';

const log = logger('providers');

/**
 * Every provider is swappable from .env, because the vendor choice is meant to
 * be settled by a bake-off on real trainer audio rather than by a datasheet.
 * Mock implementations are the default so a fresh checkout runs end to end
 * before anyone has a cloud account.
 */
export async function createProviders(config) {
  const { asr, mt, tts } = config.providers;

  const asrFactory = {
    mock: async () => (await import('./asr-mock.js')).createAsr(config),
    azure: async () => (await import('./asr-azure.js')).createAsr(config),
  }[asr];

  const mtFactory = {
    mock: async () => (await import('./mt-mock.js')).createMt(config),
    claude: async () => (await import('./mt-claude.js')).createMt(config),
    azure: async () => (await import('./mt-azure.js')).createMt(config),
  }[mt];

  const ttsFactory = {
    mock: async () => (await import('./tts-mock.js')).createTts(config),
    azure: async () => (await import('./tts-azure.js')).createTts(config),
  }[tts];

  if (!asrFactory) throw new Error(`Unknown ASR_PROVIDER "${asr}" (use: mock, azure)`);
  if (!mtFactory) throw new Error(`Unknown MT_PROVIDER "${mt}" (use: mock, claude, azure)`);
  if (!ttsFactory) throw new Error(`Unknown TTS_PROVIDER "${tts}" (use: mock, azure)`);

  // The fallback translator only exists if it is configured and is not already
  // the primary. A silent channel is worse than a blunter sentence.
  let mtFallback = null;
  if (mt !== 'azure' && config.azure.translatorKey) {
    try {
      mtFallback = (await import('./mt-azure.js')).createMt(config);
    } catch (err) {
      log.warn('translator fallback unavailable', { err: err.message });
    }
  }

  const providers = {
    asr: await asrFactory(),
    mt: await mtFactory(),
    tts: await ttsFactory(),
    mtFallback,
  };

  log.info('ready', {
    asr: providers.asr.name,
    mt: providers.mt.name,
    tts: providers.tts.name,
    fallback: mtFallback?.name || 'none',
  });

  return providers;
}
