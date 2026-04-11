import { runCodex } from './codex-runner.js';
import { runGemini } from './gemini-runner.js';

export async function runProvider(config, session, userText, options = {}) {
  switch (normalizeProvider(config.provider)) {
    case 'codex':
      return runCodex(config, session, userText, options);
    case 'gemini':
      return runGemini(config, session, userText, options);
    default:
      return {
        ok: false,
        error: `unsupported LLM_PROVIDER: ${config.provider}`,
        text: '',
        reasonings: [],
        logs: [],
        threadId: null,
      };
  }
}

export function getProviderLabel(config) {
  const provider = normalizeProvider(config.provider);
  if (provider === 'gemini') return 'Gemini';
  return 'Codex';
}

function normalizeProvider(value) {
  const provider = String(value || 'codex').trim().toLowerCase();
  return provider || 'codex';
}
