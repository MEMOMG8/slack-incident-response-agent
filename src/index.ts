import { App } from '@slack/bolt';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { escalateIncident as escalateViaMcp } from './mcp-client';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
});

// ==================== CLASSIFICATION (Slack AI) ====================

type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

interface ClassifiedIncident {
  id: string;
  severity: Severity;
  service: string;
  emoji: string;
  confidence: number;
}

function generateIncidentId(): string {
  return `INC-${Date.now().toString(36).toUpperCase()}`;
}

function classifyAlert(text: string): ClassifiedIncident {
  const lowerText = text.toLowerCase();

  let severity: Severity = 'LOW';
  let confidence = 0.5;

  const criticalKeywords = ['down', 'outage', 'critical', 'unavailable', 'emergency'];
  const highKeywords = ['error', 'failure', 'exhausted', 'high cpu', 'memory', 'failed'];
  const mediumKeywords = ['warning', 'slow', 'degraded', 'timeout', 'latency'];

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
    auth: 'Authentication Service',
    api: 'API Gateway',
    database: 'Database',
    db: 'Database',
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
    id: generateIncidentId(),
    severity,
    service,
    emoji: emojiMap[severity],
    confidence,
  };
}

// ==================== REAL-TIME SEARCH (Incident history) ====================

interface HistoricalIncident {
  title: string;
  resolution: string;
  timeToResolveMinutes: number;
  occurredDaysAgo: number;
}

const historicalDatabase: Record<string, HistoricalIncident[]> = {
  'Payment Service': [
    {
      title: 'Payment Service timeout under high load',
      resolution: 'Scaled pods from 3 to 8 and increased timeout from 5s to 15s',
      timeToResolveMinutes: 28,
      occurredDaysAgo: 14,
    },
    {
      title: 'Payment Service down after deploy',
      resolution: 'Rolled back to previous deploy, the new build had a missing environment variable',
      timeToResolveMinutes: 12,
      occurredDaysAgo: 45,
    },
  ],
  Database: [
    {
      title: 'Database connection pool exhausted',
      resolution: 'Enabled connection pooling and reduced max connections from 500 to 100',
      timeToResolveMinutes: 35,
      occurredDaysAgo: 7,
    },
    {
      title: 'Database high query latency',
      resolution: 'Added a missing index on the transactions table',
      timeToResolveMinutes: 50,
      occurredDaysAgo: 30,
    },
  ],
  'API Gateway': [
    {
      title: 'API Gateway memory leak',
      resolution: 'Restarted the service and applied the fix from commit abc123 in the next deploy',
      timeToResolveMinutes: 20,
      occurredDaysAgo: 10,
    },
  ],
  'Cache Service': [
    {
      title: 'Cache Service low hit rate',
      resolution: 'Increased TTL for frequently accessed keys and increased allocated memory',
      timeToResolveMinutes: 40,
      occurredDaysAgo: 21,
    },
  ],
  'Authentication Service': [
    {
      title: 'Authentication Service rejecting valid tokens',
      resolution: 'Server clock was out of sync, resynced with NTP',
      timeToResolveMinutes: 18,
      occurredDaysAgo: 5,
    },
  ],
  'Notification Service': [
    {
      title: 'Notification Service queue stuck',
      resolution: 'Purged duplicate messages from the queue and restarted the worker',
      timeToResolveMinutes: 22,
      occurredDaysAgo: 18,
    },
  ],
};

function searchHistoricalIncidents(service: string): HistoricalIncident[] {
  return historicalDatabase[service] || [];
}

// ==================== INCIDENT STORE (for MCP escalation) ====================

interface IncidentRecord {
  classification: ClassifiedIncident;
  originalText: string;
  similarIncidents: HistoricalIncident[];
}

// In-memory store so the "Escalate" button (and auto-escalation) can look up
// the full incident context by Incident ID. Fine for a hackathon demo;
// would move to a DB for production use.
const incidentStore = new Map<string, IncidentRecord>();

function toMcpSimilarIncidents(similar: HistoricalIncident[]) {
  return similar.map((inc) => ({
    title: inc.title,
    time_ago: `${inc.occurredDaysAgo} days ago`,
    resolved_in: `${inc.timeToResolveMinutes} min`,
    resolution: inc.resolution,
  }));
}

async function runEscalation(record: IncidentRecord, say: any) {
  const result = await escalateViaMcp({
    incident_id: record.classification.id,
    severity: record.classification.severity,
    service: record.classification.service,
    confidence: record.classification.confidence,
    original_message: record.originalText,
    similar_incidents: toMcpSimilarIncidents(record.similarIncidents),
  });

  if (result.ok && result.channel_id) {
    await say({
      text: `Incident escalated to #${result.channel_name}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `:rotating_light: *Incident escalated via MCP*\n` +
              `A dedicated channel <#${result.channel_id}> was created, briefed with incident context and history, and the on-call engineer was notified.`,
          },
        },
      ],
    });
  } else {
    await say(
      `:warning: Could not escalate this incident via MCP (${result.error || 'unknown error'}). Check the bot permissions (channels:manage) and that ONCALL_USER_ID is set in .env.local.`
    );
  }
}

// ==================== HANDLER ====================

app.message(async ({ message, say }) => {
  const msg = message as any;
  if (!msg.text) return;
  if (msg.subtype) return;
  if (msg.bot_id) return;

  console.log('Message received:', msg.text);

  const classification = classifyAlert(msg.text);
  const similarIncidents = searchHistoricalIncidents(classification.service);

  // Save context so the Escalate button (and auto-escalation below) can use it
  incidentStore.set(classification.id, {
    classification,
    originalText: msg.text,
    similarIncidents,
  });

  await say({
    text: `Incident classified: ${classification.severity}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `Incident classified: ${classification.severity}`,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Incident ID:*\n${classification.id}`,
          },
          {
            type: 'mrkdwn',
            text: `*Severity:*\n${classification.emoji} ${classification.severity}`,
          },
          {
            type: 'mrkdwn',
            text: `*Service:*\n${classification.service}`,
          },
          {
            type: 'mrkdwn',
            text: `*Confidence:*\n${(classification.confidence * 100).toFixed(0)}%`,
          },
          {
            type: 'mrkdwn',
            text: `*Original message:*\n${msg.text}`,
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
              text: 'Resolve',
            },
            action_id: 'incident_resolve',
            style: 'primary',
            value: classification.id,
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Escalate',
            },
            action_id: 'incident_escalate',
            style: 'danger',
            value: classification.id,
          },
        ],
      },
    ],
  });

  // ===== Search historical context (Real-Time Search) =====
  if (similarIncidents.length > 0) {
    const historyText = similarIncidents
      .map((inc) => {
        return `*${inc.title}*\n_${inc.occurredDaysAgo} days ago - resolved in ${inc.timeToResolveMinutes} min_\nResolution: ${inc.resolution}`;
      })
      .join('\n\n');

    await say({
      text: `Found ${similarIncidents.length} similar incident(s)`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:mag: *Similar incidents found (${similarIncidents.length})*\n\n${historyText}`,
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'Results from Real-Time Search over incident history',
            },
          ],
        },
      ],
    });
  } else {
    await say({
      text: 'No similar historical incidents found',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:mag: No similar historical incidents found for *${classification.service}*. This could be a new type of issue.`,
          },
        },
      ],
    });
  }

  // ===== Automatic escalation via MCP =====
  if (classification.severity === 'CRITICAL') {
    await say(':rotating_light: Severity is CRITICAL — escalating automatically via MCP...');
    const record = incidentStore.get(classification.id)!;
    await runEscalation(record, say);
  }
});

// ==================== ACTIONS ====================

app.action('incident_resolve', async ({ ack, say, body }) => {
  await ack();
  const incidentId = (body as any).actions?.[0]?.value;
  if (say) {
    await say(
      incidentId
        ? `Incident *${incidentId}* marked as resolved.`
        : 'Incident marked as resolved.'
    );
  }
});

app.action('incident_escalate', async ({ ack, say, body }) => {
  await ack();

  const incidentId = (body as any).actions?.[0]?.value;
  const record = incidentId ? incidentStore.get(incidentId) : undefined;

  if (!record) {
    if (say) {
      await say('Could not find incident details to escalate. Please classify a new alert first.');
    }
    return;
  }

  if (say) {
    await say(`:hourglass_flowing_sand: Escalating *${record.classification.id}* via MCP...`);
    await runEscalation(record, say);
  }
});

// ==================== START ====================

(async () => {
  await app.start(3000);
  console.log('Bot listening on port 3000');
})();
