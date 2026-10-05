// Vercel entry point: every request is routed here (see vercel.json) and handed
// to the same app the local server uses. The app is created once per warm
// function instance and reused.
'use strict';
const { loadConfig } = require('../server/config.js');
const { createApp } = require('../server/app.js');

let appPromise = null;

module.exports = async function handler(req, res) {
  if (!appPromise) {
    appPromise = (async () => createApp(loadConfig(), { log: console }))();
    appPromise.catch(() => { appPromise = null; }); // retry setup on the next request
  }
  let app;
  try {
    app = await appPromise;
  } catch (e) {
    // Most likely a missing environment variable: say which, without leaking secrets.
    console.error(e);
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`Campaign Analyser isn't configured yet: ${e.message}`);
    return;
  }
  return app.handle(req, res);
};
