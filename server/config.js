// Settings come from environment variables (or a .env file next to package.json).
// Three ways to run:
//   - demo:    no META_APP_ID; a simulated Meta account, only on this computer
//   - local:   your Meta app, data in data/analyser.db (node:sqlite)
//   - hosted:  on Vercel, data in Turso (TURSO_DATABASE_URL), secrets from env vars
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');

function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  if (typeof process.loadEnvFile === 'function') { process.loadEnvFile(file); return; }
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/** A 32-byte key for encrypting tokens and signing cookies. */
function secretKey(env, dataDir, hosted) {
  if (env.APP_SECRET_KEY) {
    const k = Buffer.from(env.APP_SECRET_KEY, 'base64');
    if (k.length !== 32) throw new Error('APP_SECRET_KEY must be 32 random bytes in base64. Make one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
    return k;
  }
  if (hosted) throw new Error('APP_SECRET_KEY is missing. Hosted servers can\'t keep a key file; add it as an environment variable (see DEPLOY-VERCEL.md).');
  const file = path.join(dataDir, 'secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
}

function loadConfig(overrides = {}) {
  loadEnvFile();
  const env = { ...process.env, ...overrides };
  const hosted = !!env.VERCEL;
  const port = Number(env.PORT || 8787);
  const demo = env.DEMO === '1' || !env.META_APP_ID;
  const host = env.HOST || '127.0.0.1';
  const vercelUrl = env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : null;
  const baseUrl = (env.BASE_URL || vercelUrl || `http://localhost:${port}`).replace(/\/$/, '');
  const tursoUrl = env.TURSO_DATABASE_URL || env.LIBSQL_URL || '';

  // Demo mode uses a public, made-up app secret: only ever allow it on this computer.
  if (demo && (hosted || !['127.0.0.1', 'localhost', '::1'].includes(host) || baseUrl.startsWith('https://'))) {
    throw new Error('Demo mode only runs on this computer. Set META_APP_ID and META_APP_SECRET to host the app.');
  }
  if (!demo && !env.META_APP_SECRET) throw new Error('META_APP_SECRET is missing (Meta app → App settings → Basic).');
  if (hosted && !tursoUrl) throw new Error('No database configured. On Vercel the app needs Turso: add TURSO_DATABASE_URL and TURSO_AUTH_TOKEN (see DEPLOY-VERCEL.md).');
  if (hosted && !baseUrl.startsWith('https://')) throw new Error('BASE_URL must be the https:// address of the deployment.');

  // Local data folder (not used when the database is Turso).
  const dataDir = hosted ? '/tmp' : path.resolve(ROOT, env.DATA_DIR || 'data');
  if (!hosted) fs.mkdirSync(dataDir, { recursive: true });

  return {
    port,
    host,
    baseUrl,
    hosted,
    dataDir,
    db: tursoUrl ? { url: tursoUrl, authToken: env.TURSO_AUTH_TOKEN } : { file: env.DB_FILE || path.join(dataDir, 'analyser.db') },
    key: secretKey(env, dataDir, hosted),
    demo,
    cronSecret: env.CRON_SECRET || '',
    meta: {
      appId: demo ? 'demo-app' : env.META_APP_ID,
      appSecret: demo ? 'demo-secret' : env.META_APP_SECRET,
      configId: env.META_LOGIN_CONFIG_ID || '',      // Facebook Login for Business configuration, if used
      version: env.META_API_VERSION || 'v25.0',
      graphUrl: env.META_GRAPH_URL || 'https://graph.facebook.com',
      dialogUrl: env.META_DIALOG_URL || 'https://www.facebook.com',
      backfillDays: Number(env.SYNC_BACKFILL_DAYS || 90),
    },
    // How people connect Meta: 'token' (paste an access token), 'oauth' (Facebook Login), or both.
    // Facebook Login for Business needs Business Verification, so token is the default.
    loginModes: demo ? ['oauth', 'token'] : String(env.META_LOGIN_MODE || 'token').split(/[ ,]+/).filter((m) => ['token', 'oauth'].includes(m)),
    syncEveryHours: Number(env.SYNC_EVERY_HOURS || 24),
    // Longest a single sync step may run. Vercel's free plan stops functions at 300 s.
    syncStepMs: Number(env.SYNC_STEP_SECONDS || 240) * 1000,
    shareDays: Number(env.SHARE_DAYS || 30),
    distDir: path.join(ROOT, 'dist'),
  };
}

module.exports = { loadConfig, ROOT };
