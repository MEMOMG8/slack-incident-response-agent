import { App } from '@slack/bolt';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
});

app.message(async ({ message, say }) => {
  const msg = message as any;
  if (msg.text) {
    console.log('Mensaje recibido:', msg.text);
    await say('Hola! Soy el agente de incidentes. Recibí: ' + msg.text);
  }
});

(async () => {
  await app.start(3000);
  console.log('Bot escuchando en puerto 3000');
})();