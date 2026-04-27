const BASE_URL = 'https://api.xbai.top';
const PROVIDER = 'xbai';

export async function createRecharge(config) {
  const providerConfig = getProviderConfig(config);
  const username = String(providerConfig.username || '').trim();
  const password = String(providerConfig.password || '').trim();
  const paymentMethod = String(providerConfig.paymentMethod || 'alipay').trim() || 'alipay';
  const amount = Number(providerConfig.amount || 5) || 5;
  const timeoutMs = Number(providerConfig.timeoutMs || 30000) || 30000;

  if (!username || !password) {
    return { ok: false, error: 'missing_config', provider: PROVIDER, presentation: 'link', text: '', url: '', imagePath: '' };
  }

  const signal = AbortSignal.timeout(timeoutMs);

  try {
    const session = await login({ username, password, signal });
    const payData = await createPayOrder({ ...session, paymentMethod, amount, signal });
    const paymentUrl = await getQrUrl({ ...session, signal }, payData);
    return {
      ok: true,
      error: '',
      provider: PROVIDER,
      presentation: 'link',
      text: '',
      url: paymentUrl,
      imagePath: '',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (signal.aborted || /timeout/i.test(message)) {
      return { ok: false, error: 'timeout', provider: PROVIDER, presentation: 'link', text: '', url: '', imagePath: '' };
    }
    return { ok: false, error: message, provider: PROVIDER, presentation: 'link', text: '', url: '', imagePath: '' };
  }
}

export async function getBalance(config) {
  const providerConfig = getProviderConfig(config);
  const username = String(providerConfig.username || '').trim();
  const password = String(providerConfig.password || '').trim();
  const timeoutMs = Number(providerConfig.timeoutMs || 30000) || 30000;

  if (!username || !password) {
    return { ok: false, error: 'missing_config', provider: PROVIDER, balance: 0, currency: 'CNY' };
  }

  const signal = AbortSignal.timeout(timeoutMs);

  try {
    const session = await login({ username, password, signal });
    const profile = await getSelfInfo({ ...session, signal });
    const quota = Number(profile?.quota || 0) || 0;
    return {
      ok: true,
      error: '',
      provider: PROVIDER,
      balance: quotaToCurrency(quota),
      currency: 'CNY',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (signal.aborted || /timeout/i.test(message)) {
      return { ok: false, error: 'timeout', provider: PROVIDER, balance: 0, currency: 'CNY' };
    }
    return { ok: false, error: message, provider: PROVIDER, balance: 0, currency: 'CNY' };
  }
}

function getProviderConfig(config) {
  return config?.billing?.xbai || {};
}

function quotaToCurrency(value) {
  return Number((Number(value || 0) / 500000).toFixed(2));
}

function getCookieHeader(headers) {
  const setCookie = headers.getSetCookie ? headers.getSetCookie() : [];
  if (setCookie.length > 0) {
    return setCookie.map((cookie) => cookie.split(';')[0]).join('; ');
  }
  const singleCookie = headers.get('set-cookie');
  return singleCookie ? singleCookie.split(';')[0] : '';
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('invalid_json');
  }

  if (!response.ok || data.success === false) {
    throw new Error(`request_failed_${response.status}`);
  }

  return { response, data };
}

function extractQrPath(html) {
  const match = String(html || '').match(/window\.location\.replace\(['"](?<path>\/pay\/qrcode\/[^'"]+)['"]\)/);
  if (!match?.groups?.path) {
    throw new Error('missing_payment_path');
  }
  return match.groups.path;
}

async function login({ username, password, signal }) {
  const { response, data } = await requestJson(`${BASE_URL}/api/user/login?turnstile=`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: BASE_URL,
      Referer: `${BASE_URL}/login`,
    },
    body: JSON.stringify({
      username,
      password,
      captcha_token: '',
    }),
    signal,
  });

  const cookie = getCookieHeader(response.headers);
  if (!cookie) {
    throw new Error('missing_cookie');
  }

  return {
    cookie,
    userId: data.data.id,
  };
}

async function createPayOrder({ cookie, userId, paymentMethod, amount, signal }) {
  const { data } = await requestJson(`${BASE_URL}/api/user/pay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      Cookie: cookie,
      'New-Api-User': String(userId),
      Origin: BASE_URL,
      Referer: `${BASE_URL}/console/topup`,
    },
    body: JSON.stringify({
      amount,
      top_up_code: '',
      payment_method: paymentMethod,
    }),
    signal,
  });

  return data.data ?? data;
}

async function getSelfInfo({ cookie, userId, signal }) {
  const { data } = await requestJson(`${BASE_URL}/api/user/self`, {
    method: 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*',
      Cookie: cookie,
      'New-Api-User': String(userId),
      Origin: BASE_URL,
      Referer: `${BASE_URL}/console`,
    },
    signal,
  });

  return data.data;
}

async function getQrUrl({ cookie, userId, signal }, payData) {
  if (typeof payData === 'string' && /\/pay\/qrcode\//.test(payData)) {
    return new URL(payData, BASE_URL).toString();
  }

  if (payData?.qr_url) {
    return new URL(payData.qr_url, BASE_URL).toString();
  }

  if (payData?.url && payData?.params) {
    const formBody = new URLSearchParams(payData.params).toString();
    const response = await fetch(payData.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Cookie: cookie,
        'New-Api-User': String(userId),
        Origin: BASE_URL,
        Referer: `${BASE_URL}/console/topup`,
      },
      body: formBody,
      signal,
    });

    const html = await response.text();
    if (!response.ok) {
      throw new Error(`checkout_failed_${response.status}`);
    }

    const qrPath = extractQrPath(html);
    return new URL(qrPath, BASE_URL).toString();
  }

  if (payData?.pid && payData?.out_trade_no && payData?.sign) {
    const submitUrl = 'https://pay.xbai.top/submit.php';
    const response = await fetch(submitUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Origin: 'https://pay.xbai.top',
        Referer: `${BASE_URL}/console/topup`,
      },
      body: new URLSearchParams(payData).toString(),
      signal,
    });

    const html = await response.text();
    if (!response.ok) {
      throw new Error(`submit_checkout_failed_${response.status}`);
    }

    const qrPath = extractQrPath(html);
    return new URL(qrPath, 'https://pay.xbai.top').toString();
  }

  throw new Error('unknown_payment_shape');
}
