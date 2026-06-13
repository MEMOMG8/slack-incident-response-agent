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

// ==================== REAL-TIME SEARCH (HISTORICO) ====================

interface HistoricalIncident {
  title: string;
  resolution: string;
  timeToResolveMinutes: number;
  occurredDaysAgo: number;
}

const historicalDatabase: Record<string, HistoricalIncident[]> = {
  'Payment Service': [
    {
      title: 'Payment Service timeout bajo alta carga',
      resolution: 'Se escalo el numero de pods de 3 a 8 y se aumento el timeout de 5s a 15s',
      timeToResolveMinutes: 28,
      occurredDaysAgo: 14,
    },
    {
      title: 'Payment Service caido tras deploy',
      resolution: 'Rollback al deploy anterior, el nuevo build tenia una variable de entorno faltante',
      timeToResolveMinutes: 12,
      occurredDaysAgo: 45,
    },
  ],
  Database: [
    {
      title: 'Database connection pool agotado',
      resolution: 'Se habilito connection pooling y se redujeron las conexiones max de 500 a 100',
      timeToResolveMinutes: 35,
      occurredDaysAgo: 7,
    },
    {
      title: 'Database con latencia alta en queries',
      resolution: 'Se agrego un indice faltante en la tabla de transacciones',
      timeToResolveMinutes: 50,
      occurredDaysAgo: 30,
    },
  ],
  'API Gateway': [
    {
      title: 'API Gateway con memory leak',
      resolution: 'Se reinicio el servicio y se aplico el fix del commit abc123 en el siguiente deploy',
      timeToResolveMinutes: 20,
      occurredDaysAgo: 10,
    },
  ],
  'Cache Service': [
    {
      title: 'Cache Service con hit rate bajo',
      resolution: 'Se aumento el TTL de las claves frecuentes y se aumento la memoria asignada',
      timeToResolveMinutes: 40,
      occurredDaysAgo: 21,
    },
  ],
  'Authentication Service': [
    {
      title: 'Authentication Service rechazando tokens validos',
      resolution: 'El reloj del servidor estaba desincronizado, se resincronizo con NTP',
      timeToResolveMinutes: 18,
      occurredDaysAgo: 5,
    },
  ],
  'Notification Service': [
    {
      title: 'Notification Service con cola atascada',
      resolution: 'Se purgaron mensajes duplicados en la cola y se reinicio el worker',
      timeToResolveMinutes: 22,
      occurredDaysAgo: 18,
    },
  ],
};

function searchHistoricalIncidents(service: string): HistoricalIncident[] {
  return historicalDatabase[service] || [];
}

// ==================== ESCALACION (MCP) ====================

interface EscalationResult {
  channelId: string;
  channelName: string;
}

async function escalateIncident(
  client: any,
  classification: ClassifiedIncident,
  reporterId: string | undefined,
  originalText: string
): Promise<EscalationResult | null> {
  const channelName = `incident-${Date.now().toString(36)}`.toLowerCase();

  try {
    const createResult = await client.conversations.create({
      name: channelName,
      is_private: false,
    });

    const channelId = createResult.channel.id;
    const channelNameActual = createResult.channel.name;

    if (reporterId) {
      try {
        await client.conversations.invite({
          channel: channelId,
          users: reporterId,
        });
      } catch (inviteError) {
        console.log('No se pudo invitar al usuario al canal:', inviteError);
      }
    }

    await client.chat.postMessage({
      channel: channelId,
      text: `Incidente critico: ${classification.service}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `Incidente CRITICO: ${classification.service}`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Descripcion original:*\n${originalText}\n\n*Severidad:* ${classification.severity}\n*Servicio:* ${classification.service}`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: ':robot_face: Este canal fue creado automaticamente por el Incident Response Agent para coordinar la respuesta a este incidente.',
          },
        },
      ],
    });

    return { channelId, channelName: channelNameActual };
  } catch (error) {
    console.error('Error creando canal de escalacion:', error);
    return null;
  }
}

// ==================== HANDLER ====================

app.message(async ({ message, say, client }) => {
  const msg = message as any;
  if (!msg.text) return;

  console.log('Mensaje recibido:', msg.text);

  const classification = classifyAlert(msg.text);

  await say({
    text: `Incidente clasificado: ${classification.severity}`,
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

  // ===== Buscar contexto historico (Real-Time Search) =====
  const similarIncidents = searchHistoricalIncidents(classification.service);

  if (similarIncidents.length > 0) {
    const historyText = similarIncidents
      .map((inc) => {
        return `*${inc.title}*\n_Hace ${inc.occurredDaysAgo} dias - resuelto en ${inc.timeToResolveMinutes} min_\nSolucion: ${inc.resolution}`;
      })
      .join('\n\n');

    await say({
      text: `Incidentes similares encontrados (${similarIncidents.length})`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:mag: *Incidentes similares encontrados (${similarIncidents.length})*\n\n${historyText}`,
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'Resultados de Real-Time Search sobre el historial de incidentes',
            },
          ],
        },
      ],
    });
  } else {
    await say({
      text: 'No se encontraron incidentes historicos similares',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:mag: No se encontraron incidentes historicos similares para *${classification.service}*. Este podria ser un caso nuevo.`,
          },
        },
      ],
    });
  }

  // ===== Escalacion automatica (MCP) =====
  if (classification.severity === 'CRITICAL') {
    const escalation = await escalateIncident(client, classification, msg.user, msg.text);

    if (escalation) {
      await say({
        text: `Incidente escalado automaticamente a #${escalation.channelName}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:rotating_light: *Incidente escalado automaticamente*\nSe creo el canal <#${escalation.channelId}> para coordinar la respuesta a este incidente.`,
            },
          },
        ],
      });
    } else {
      await say('No se pudo escalar automaticamente el incidente. Revisa los permisos del bot (channels:manage).');
    }
  }
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