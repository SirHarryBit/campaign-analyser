// Small security helpers: token encryption, random ids, cookies, Meta signed requests.
'use strict';
const crypto = require('node:crypto');

const randomId = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

/** AES-256-GCM. Output: base64url(iv | tag | ciphertext). */
function encrypt(plain, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}
function decrypt(blob, key) {
  const buf = Buffer.from(blob, 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

function hmac(data, key) {
  return crypto.createHmac('sha256', key).update(data).digest('base64url');
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** A value plus its signature, so the browser can carry it without being able to change it. */
function sign(value, key) {
  const v = Buffer.from(JSON.stringify(value)).toString('base64url');
  return v + '.' + hmac(v, key);
}
function unsign(token, key) {
  if (!token || !token.includes('.')) return null;
  const [v, sig] = token.split('.');
  if (!safeEqual(sig, hmac(v, key))) return null;
  try { return JSON.parse(Buffer.from(v, 'base64url').toString('utf8')); } catch { return null; }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    // Another app on localhost can set junk cookies; never let one break every request.
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed cookie */ }
  }
  return out;
}
function cookie(name, value, { maxAge, secure, httpOnly = true, sameSite = 'Lax', path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  return c;
}

/**
 * Meta's signed_request (used by the deauthorize and data-deletion callbacks):
 * base64url(signature).base64url(payload), signature = HMAC-SHA256(payload, app secret).
 */
function parseSignedRequest(signed, appSecret) {
  if (!signed || !signed.includes('.')) return null;
  const [sig, payload] = signed.split('.', 2);
  const expected = crypto.createHmac('sha256', appSecret).update(payload).digest('base64url');
  if (!safeEqual(sig.replace(/=+$/, ''), expected)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (String(data.algorithm || '').toUpperCase() !== 'HMAC-SHA256') return null;
  if (data.issued_at && Math.abs(Date.now() / 1000 - Number(data.issued_at)) > 7 * 86400) return null;
  return data;
}

module.exports = { randomId, encrypt, decrypt, sign, unsign, parseCookies, cookie, parseSignedRequest, safeEqual };
