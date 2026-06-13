import { App } from '@slack/bolt';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
});

// ==================== CLASIFICACION ====================

type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

interface ClassifiedIncident {
  severity: Severity;
  service: string;
  emoji: string;
  confidence: number;
}

function classifyAlert(text: string): ClassifiedIncident {
  const lowerText = text.toLowerCase();

  // Determinar severidad
  let severity: Severity = 'LOW';
  let confidence = 0.5;

  const criticalKeywords = ['down', 'outage', 'critical', 'caido', 'caída', 'emergencia'];
  const highKeywords = ['error', 'failure', 'exhausted', 'high cpu', 'memory', 'falla', 'agotado'];
  const mediumKeywords = ['warning', 'slow', 'degraded', 'timeout', 'lento', 'advertencia'];

  if (criticalKeywords.some((kw) => lowerText.includes(kw))) {
    severity = 'CRITICAL';
    confidence = 0.95;
  } else if (highKeywords.some((kw) => lowerText.includes(kw))) {
    severity = 'HIGH';
    confidence = 0.85;
  } else if (mediumKeywords.some((kw) => lowerText.includes(kw))) {
    severity = 'MEDIUM';
    confidence = 0.75;
  }

  // Determinar servicio
  const serviceKeywords: Record<string, string> = {
    payment: 'Payment Service',
    pago: 'Payment Service',
    auth: 'Authentication Service',
    api: 'API Gateway',
    database: 'Database',
    'base de datos': 'Database',
    cache: 'Cache Service',
    notification: 'Notification Service',
  };

  let service = 'Unknown Service';
  for (const [keyword, name] of Object.entries(serviceKeywords)) {
    if (lowerText.includes(keyword)) {
      service = name;
      break;
    }
  }

  const emojiMap: Record<Severity, string> = {
    CRITICAL: ':red_circle:',
    HIGH: ':large_orange_circle:',
    MEDIUM: ':large_yellow_circle:',
    LOW: ':large_blue_circle:',
  };

  return {
    severity,
    service,
    emoji: emojiMap[severity],
    confidence,
  };
}

// ==================== HANDLER ====================

app.message(async ({ message, say }) => {
  const msg = message as any;
  if (!msg.text) return;

  console.log('Mensaje recibido:', msg.text);

  const classification = classifyAlert(msg.text);

  await say({
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `Incidente clasificado: ${classification.severity}`,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Severidad:*\n${classification.emoji} ${classification.severity}`,
          },
          {
            type: 'mrkdwn',
            text: `*Servicio:*\n${classification.service}`,
          },
          {
            type: 'mrkdwn',
            text: `*Confianza:*\n${(classification.confidence * 100).toFixed(0)}%`,
          },
          {
            type: 'mrkdwn',
            text: `*Descripcion original:*\n${msg.text}`,
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Resolver',
            },
            action_id: 'incident_resolve',
            style: 'primary',
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Escalar',
            },
            action_id: 'incident_escalate',
            style: 'danger',
          },
        ],
      },
    ],
  });
});

// ==================== ACCIONES ====================

app.action('incident_resolve', async ({ ack, say }) => {
  await ack();
  if (say) await say('Incidente marcado como resuelto.');
});

app.action('incident_escalate', async ({ ack, say }) => {
  await ack();
  if (say) await say('Incidente escalado al equipo on-call.');
});

// ==================== START ====================

(async () => {
  await app.start(3000);
  console.log('Bot escuchando en puerto 3000');
})();
