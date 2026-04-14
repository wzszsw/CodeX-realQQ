const BASE_URL = 'https://api.n1n.ai';

export async function createRechargeLink(config) {
  const username = String(config?.recharge?.username || '').trim();
  const password = String(config?.recharge?.password || '').trim();
  const paymentMethod = String(config?.recharge?.paymentMethod || 'wxpay').trim() || 'wxpay';
  const amount = Number(config?.recharge?.amount || 5) || 5;
  const timeoutMs = Number(config?.recharge?.timeoutMs || 30000) || 30000;

  if (!username || !password) {
    return { ok: false, error: 'missing_config', url: '' };
  }

  const signal = AbortSignal.timeout(timeoutMs);

  try {
    const session = await login({ username, password, signal });
    const payData = await createPayOrder({ ...session, paymentMethod, amount, signal });
    const paymentUrl = await getPaymentUrl({ ...session, signal }, payData);
    return { ok: true, error: '', url: paymentUrl };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (signal.aborted || /timeout/i.test(message)) {
      return { ok: false, error: 'timeout', url: '' };
    }
    return { ok: false, error: message, url: '' };
  }
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

  return data.data;
}

async function getPaymentUrl({ cookie, userId, signal }, payData) {
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
  return `${BASE_URL}${qrPath}`;
}
