// Vercel entry point: every request is routed here (see vercel.json) and handed
// to the same app the local server uses. The app is created once per warm
// function instance and reused.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConfigApi } from '../server/config.ts';
import type { AppApi, App } from '../server/app.ts';
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');

// On Vercel the build (build.ts) writes the server as plain JavaScript to dist/server/, so nothing here
// depends on the runtime stripping TypeScript types. Without a build (local runs, tests) the .ts sources are used.
const ROOT = path.join(__dirname, '..');
const built = path.join(ROOT, 'dist', 'server');
const useBuilt = fs.existsSync(path.join(built, 'config.js'));
const load = (name: string): any => require(useBuilt ? path.join(built, name + '.js') : path.join(ROOT, 'server', name + '.ts'));
const { loadConfig }: ConfigApi = load('config');
const { createApp }: AppApi = load('app');

// Never runs: it lets Vercel's file tracer see the database driver, which db.js loads on demand.
if (process.env.NEVER_SET_TRACE_HINT) require('@libsql/client');

let appPromise: Promise<App> | null = null;

module.exports = async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!appPromise) {
    appPromise = (async () => createApp({ ...loadConfig(), distDir: path.join(ROOT, 'dist') }, { log: console }))();
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
