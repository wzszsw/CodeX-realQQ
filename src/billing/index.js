import { createRecharge as createN1nRecharge, getBalance as getN1nBalance } from './n1n-provider.js';
import { createRecharge as createXbaiRecharge, getBalance as getXbaiBalance } from './xbai-provider.js';

export async function createRecharge(config) {
  const provider = normalizeBillingProvider(config?.billing?.provider);
  switch (provider) {
    case 'n1n':
      return createN1nRecharge(config);
    case 'xbai':
      return createXbaiRecharge(config);
    default:
      return {
        ok: false,
        error: `unsupported BILLING_PROVIDER: ${provider}`,
        provider,
        presentation: 'link',
        text: '',
        url: '',
        imagePath: '',
      };
  }
}

export async function getBalance(config) {
  const provider = normalizeBillingProvider(config?.billing?.provider);
  switch (provider) {
    case 'n1n':
      return getN1nBalance(config);
    case 'xbai':
      return getXbaiBalance(config);
    default:
      return {
        ok: false,
        error: `unsupported BILLING_PROVIDER: ${provider}`,
        provider,
        balance: 0,
        currency: 'CNY',
      };
  }
}

function normalizeBillingProvider(value) {
  const provider = String(value || 'n1n').trim().toLowerCase();
  return provider || 'n1n';
}
