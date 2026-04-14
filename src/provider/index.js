import { runCodex } from './codex-runner.js';
import { runGemini } from './gemini-runner.js';

export async function runProvider(config, session, userText, options = {}) {
  const provider = normalizeProvider(config.provider);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const result = await runSingleProvider(provider, config, session, userText, {
    ...options,
    onProgress: onProgress ? createProviderProgressEmitter(provider, onProgress) : null,
  });

  return {
    ...result,
    provider,
    fallbackFrom: '',
  };
}

export function getProviderLabel(configOrProvider) {
  const provider = typeof configOrProvider === 'string'
    ? normalizeProvider(configOrProvider)
    : normalizeProvider(configOrProvider?.provider);
  if (provider === 'gemini') return 'Gemini';
  return 'Codex';
}

async function runSingleProvider(provider, config, session, userText, options) {
  switch (provider) {
    case 'codex':
      return runCodex(config, session, userText, options);
    case 'gemini':
      return runGemini(config, session, userText, options);
    default:
      return {
        ok: false,
        error: `unsupported LLM_PROVIDER: ${provider}`,
        text: '',
        reasonings: [],
        logs: [],
        threadId: null,
      };
  }
}

function createProviderProgressEmitter(provider, onProgress) {
  return (event) => {
    if (!event || typeof event !== 'object') return;
    onProgress({
      ...event,
      provider,
    });
  };
}

function normalizeProvider(value) {
  const provider = String(value || 'codex').trim().toLowerCase();
  return provider || 'codex';
}
