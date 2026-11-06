// Start the Campaign Analyser server:  npm start
// Without META_APP_ID in .env it runs in demo mode against the simulated Meta API.
import type { ConfigApi } from './config.ts';
import type { AppApi } from './app.ts';
import type { MockApi } from '../mock/meta-mock.ts';
const { loadConfig }: ConfigApi = require('./config.ts');
const { createApp }: AppApi = require('./app.ts');

async function main(): Promise<void> {
  const config = loadConfig();
  let mock: Awaited<ReturnType<MockApi['startMetaMock']>> | null = null;
  if (config.demo) {
    const { startMetaMock } = (require('../mock/meta-mock.ts') as MockApi);
    mock = await startMetaMock();
    config.meta.graphUrl = mock.url;
    config.meta.dialogUrl = mock.url;
  }
  const app = await createApp(config, { log: { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m), error: (e: unknown) => console.error(e) } });
  app.server.listen(config.port, config.host, () => {
    console.log(`\nCampaign Analyser running at ${config.baseUrl}`);
    console.log(config.demo
      ? 'Demo mode: "Connect Meta" signs in to a simulated ad account. Add META_APP_ID and META_APP_SECRET to .env to use your real one.'
      : `Live mode: Meta app ${config.meta.appId}, Marketing API ${config.meta.version}.`);
    console.log(`Data is stored in ${config.db.file ?? 'Turso'}\n`);
  });
  app.startScheduler();
  const stop = () => { app.close(); if (mock) mock.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => { console.error(e); process.exit(1); });
