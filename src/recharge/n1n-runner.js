import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { siAlipay } from 'simple-icons';

const BASE_URL = 'https://api.n1n.ai';

export async function createRechargeLink(config) {
  const username = String(config?.recharge?.username || '').trim();
  const password = String(config?.recharge?.password || '').trim();
  const paymentMethod = String(config?.recharge?.paymentMethod || 'wxpay').trim() || 'wxpay';
  const amount = Number(config?.recharge?.amount || 5) || 5;
  const timeoutMs = Number(config?.recharge?.timeoutMs || 30000) || 30000;

  if (!username || !password) {
    return { ok: false, error: 'missing_config', url: '', imagePath: '', paymentMethod };
  }

  const signal = AbortSignal.timeout(timeoutMs);

  try {
    const session = await login({ username, password, signal });
    const payData = await createPayOrder({ ...session, paymentMethod, amount, signal });
    const paymentUrl = await getPaymentUrl({ ...session, signal }, payData);

    if (paymentMethod === 'alipay') {
      const alipayScheme = await getAlipayScheme({ ...session, signal }, payData);
      const imagePath = await saveAlipayQrCode(config, alipayScheme, payData.trade_no || payData.order_id || Date.now());
      return { ok: true, error: '', url: paymentUrl, imagePath, paymentMethod };
    }

    return { ok: true, error: '', url: paymentUrl, imagePath: '', paymentMethod };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (signal.aborted || /timeout/i.test(message)) {
      return { ok: false, error: 'timeout', url: '', imagePath: '', paymentMethod };
    }
    return { ok: false, error: message, url: '', imagePath: '', paymentMethod };
  }
}

export async function getBalanceInfo(config) {
  const username = String(config?.recharge?.username || '').trim();
  const password = String(config?.recharge?.password || '').trim();
  const timeoutMs = Number(config?.recharge?.timeoutMs || 30000) || 30000;

  if (!username || !password) {
    return { ok: false, error: 'missing_config', quota: 0, usedQuota: 0, remainingQuota: 0 };
  }

  const signal = AbortSignal.timeout(timeoutMs);

  try {
    const session = await login({ username, password, signal });
    const profile = await getSelfInfo({ ...session, signal });
    const quota = Number(profile?.quota || 0) || 0;
    return {
      ok: true,
      error: '',
      balance: quotaToCurrency(quota),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (signal.aborted || /timeout/i.test(message)) {
      return { ok: false, error: 'timeout', quota: 0, usedQuota: 0, remainingQuota: 0 };
    }
    return { ok: false, error: message, quota: 0, usedQuota: 0, remainingQuota: 0 };
  }
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
  const value = String(html || '');
  const redirectMatch = value.match(/window\.location\.replace\(['"](?<path>\/pay\/qrcode\/[^'"]+)['"]\)/);
  if (redirectMatch?.groups?.path) {
    return redirectMatch.groups.path;
  }

  const tradeNoMatch = value.match(/name=["']out_trade_no["']\s+value=["'](?<tradeNo>\d+)["']/i);
  if (tradeNoMatch?.groups?.tradeNo) {
    return `/pay/qrcode/${tradeNoMatch.groups.tradeNo}`;
  }

  throw new Error('missing_payment_path');
}

function extractAlipayPostForm(html) {
  const formMatch = String(html || '').match(/<form[^>]*action=["'](?<action>[^"']+)["'][^>]*>(?<content>[\s\S]*?)<\/form>/i);
  if (!formMatch?.groups?.action || !formMatch.groups.content) {
    throw new Error('missing_alipay_post_form');
  }

  const params = {};
  const inputRegex = /<input[^>]*name=["'](?<name>[^"']+)["'][^>]*value=["'](?<value>[^"']*)["'][^>]*>/gi;
  for (const match of formMatch.groups.content.matchAll(inputRegex)) {
    params[match.groups.name] = match.groups.value;
  }

  return {
    action: formMatch.groups.action,
    params,
  };
}

function extractAlipayUrlScheme(html) {
  const match = String(html || '').match(/var\s+url_scheme\s*=\s*['"](?<scheme>alipays:[^'"]+)['"]/i);
  if (!match?.groups?.scheme) {
    throw new Error('missing_alipay_scheme');
  }
  return match.groups.scheme;
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

async function getAlipayScheme({ cookie, userId, signal }, payData) {
  const formBody = new URLSearchParams(payData.params).toString();
  const checkoutResponse = await fetch(payData.url, {
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

  const checkoutHtml = await checkoutResponse.text();
  if (!checkoutResponse.ok) {
    throw new Error(`checkout_failed_${checkoutResponse.status}`);
  }

  const postForm = extractAlipayPostForm(checkoutHtml);
  const submitResponse = await fetch(postForm.action, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Origin: new URL(postForm.action).origin,
      Referer: payData.url,
    },
    body: new URLSearchParams(postForm.params).toString(),
    signal,
  });

  const submitHtml = await submitResponse.text();
  if (!submitResponse.ok) {
    throw new Error(`alipay_checkout_failed_${submitResponse.status}`);
  }

  return extractAlipayUrlScheme(submitHtml);
}

async function saveAlipayQrCode(config, text, fileKey) {
  const baseDir = path.join(String(config?.attachmentDir || '.'), 'recharge');
  fs.mkdirSync(baseDir, { recursive: true });
  const filePath = path.join(baseDir, `${sanitizeFileKey(fileKey)}.png`);
  const qrBuffer = await QRCode.toBuffer(text, {
    type: 'png',
    errorCorrectionLevel: 'H',
    margin: 2,
    width: 480,
  });

  const logoBuffer = await sharp(Buffer.from(getAlipayLogoSvg()))
    .resize(108, 108, { fit: 'contain' })
    .png()
    .toBuffer();

  await sharp(qrBuffer)
    .composite([{ input: logoBuffer, gravity: 'center' }])
    .png()
    .toFile(filePath);

  return filePath;
}

function getAlipayLogoSvg() {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24">
      <rect width="24" height="24" rx="6" fill="#ffffff"/>
      <path fill="#${siAlipay.hex}" d="${siAlipay.path}" transform="translate(3 3) scale(0.75)"/>
    </svg>
  `;
}

function sanitizeFileKey(value) {
  return String(value || Date.now())
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 120);
}
