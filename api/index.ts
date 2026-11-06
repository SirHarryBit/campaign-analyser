// Vercel entry point: every request is routed here (see vercel.json) and handed
// to the same app the local server uses. The app is created once per warm
// function instance and reused.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConfigApi } from '../server/config.ts';
import type { AppApi, App } from '../server/app.ts';
const { loadConfig }: ConfigApi = require('../server/config.ts');
const { createApp }: AppApi = require('../server/app.ts');

// Vercel's tracer does not follow `require('./x.ts')`, so the server files are shipped through
// `includeFiles` in vercel.json. This line (never executed) lets the tracer see the database driver.
if (process.env.NEVER_SET_TRACE_HINT) require('@libsql/client');

let appPromise: Promise<App> | null = null;

module.exports = async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!appPromise) {
    appPromise = (async () => createApp(loadConfig(), { log: console }))();
    appPromise.catch(() => { appPromise = null; }); // retry setup on the next request
  }
  let app: App;
  try {
    app = await appPromise;
  } catch (e: any) {
    // Most likely a missing environment variable: say which, without leaking secrets.
    console.error(e);
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`Campaign Analyser isn't configured yet: ${e.message}`);
    return;
  }
  await app.handle(req, res);
};
