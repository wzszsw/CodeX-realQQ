import { runCodex } from './codex-runner.js';
import { runGemini } from './gemini-runner.js';

const PROVIDERS = ['codex', 'gemini'];

export async function runProvider(config, session, userText, options = {}) {
  const providerOrder = buildProviderOrder(config.provider);
  const failures = [];
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  for (const provider of providerOrder) {
    const result = await runSingleProvider(provider, config, session, userText, {
      ...options,
      onProgress: onProgress ? createProviderProgressEmitter(provider, onProgress) : null,
    });
    if (result.ok) {
      return {
        ...result,
        provider,
        fallbackFrom: failures.length > 0 ? failures[0].provider : '',
        logs: buildSuccessLogs(result.logs, failures),
      };
    }

    failures.push({
      provider,
      error: result.error || 'unknown error',
      logs: Array.isArray(result.logs) ? result.logs : [],
    });
  }

  return {
    ok: false,
    error: failures.map((failure) => `${getProviderLabel(failure.provider)}: ${failure.error}`).join(' | ') || 'all providers failed',
    text: '',
    reasonings: [],
    logs: failures.flatMap(formatFailureLogs),
    threadId: null,
    provider: providerOrder[providerOrder.length - 1] || normalizeProvider(config.provider),
    fallbackFrom: failures[0]?.provider || '',
  };
}

export function getProviderLabel(configOrProvider) {
  const provider = typeof configOrProvider === 'string'
    ? normalizeProvider(configOrProvider)
    : normalizeProvider(configOrProvider?.provider);
  if (provider === 'gemini') return 'Gemini';
  return 'Codex';
}

function buildProviderOrder(primaryProvider) {
  const primary = normalizeProvider(primaryProvider);
  if (!PROVIDERS.includes(primary)) return [primary];
  return [primary, ...PROVIDERS.filter((provider) => provider !== primary)];
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

function buildSuccessLogs(logs, failures) {
  const output = Array.isArray(logs) ? [...logs] : [];
  if (failures.length === 0) return output;
  return [
    ...failures.flatMap(formatFailureLogs),
    ...output,
  ];
}

function formatFailureLogs(failure) {
  return [
    `${getProviderLabel(failure.provider)} failed: ${failure.error}`,
    ...failure.logs.map((log) => `${getProviderLabel(failure.provider)} log: ${log}`),
  ];
}

function normalizeProvider(value) {
  const provider = String(value || 'codex').trim().toLowerCase();
  return provider || 'codex';
}
