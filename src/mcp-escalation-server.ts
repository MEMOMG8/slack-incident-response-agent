/**
 * MCP Escalation Server
 * -----------------------------------------------------------------------
 * This is a Model Context Protocol (MCP) server. It exposes "tools" that
 * an MCP client (our Slack bot) can call to perform real escalation
 * actions in Slack: creating a dedicated incident channel, posting a
 * briefing with context, and notifying the on-call engineer.
 *
 * It communicates with the client over stdio (standard input/output),
 * which is the standard local transport for MCP servers.
 * -----------------------------------------------------------------------
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebClient } from "@slack/web-api";
import { z } from "zod";
import * as dotenv from "dotenv";
import * as path from "path";

// Load the same .env.local file the main bot uses
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

const server = new McpServer({
  name: "incident-escalation-mcp",
  version: "1.0.0",
});

// ====================================================================
// TOOL 1: create_escalation_channel
// ====================================================================
server.registerTool(
  "create_escalation_channel",
  {
    title: "Create Escalation Channel",
    description:
      "Creates a dedicated Slack channel for an incident escalation, " +
      "named after the affected service and incident ID.",
    inputSchema: {
      incident_id: z.string().describe("The incident ID, e.g. INC-MQFOM942"),
      service: z.string().describe("The affected service, e.g. Database"),
    },
  },
  async ({ incident_id, service }) => {
    const slug = service
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const shortId = incident_id.replace("INC-", "").toLowerCase();
    const channelName = `incident-${slug}-${shortId}`.slice(0, 80);

    try {
      const result = await slack.conversations.create({
        name: channelName,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              channel_id: result.channel?.id,
              channel_name: result.channel?.name,
            }),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: err?.data?.error || err?.message || "unknown_error",
            }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ====================================================================
// TOOL 2: post_incident_briefing
// ====================================================================
server.registerTool(
  "post_incident_briefing",
  {
    title: "Post Incident Briefing",
    description:
      "Posts a formatted incident briefing (severity, service, original " +
      "message, and similar past incidents) into the given channel.",
    inputSchema: {
      channel_id: z.string(),
      incident_id: z.string(),
      severity: z.string(),
      service: z.string(),
      confidence: z.number().optional(),
      original_message: z.string(),
      similar_incidents: z
        .array(
          z.object({
            title: z.string(),
            time_ago: z.string(),
            resolved_in: z.string().optional(),
            resolution: z.string(),
          })
        )
        .optional(),
    },
  },
  async ({
    channel_id,
    incident_id,
    severity,
    service,
    confidence,
    original_message,
    similar_incidents,
  }) => {
    const severityEmoji: Record<string, string> = {
      CRITICAL: "🔴",
      HIGH: "🟠",
      MEDIUM: "🟡",
      LOW: "🔵",
    };

    let historyText = "";
    if (similar_incidents && similar_incidents.length > 0) {
      historyText =
        "\n\n*Similar past incidents:*\n" +
        similar_incidents
          .map(
            (i) =>
              `• *${i.title}* (${i.time_ago}${
                i.resolved_in ? `, resolved in ${i.resolved_in}` : ""
              })\n  _Resolution: ${i.resolution}_`
          )
          .join("\n");
    }

    const text =
      `${severityEmoji[severity] || "⚪"} *Escalated Incident: ${incident_id}*\n\n` +
      `*Severity:* ${severity}\n` +
      `*Service:* ${service}\n` +
      (confidence !== undefined
        ? `*Confidence:* ${Math.round(confidence * 100)}%\n`
        : "") +
      `*Original message:* ${original_message}` +
      historyText +
      `\n\n_This channel was created automatically via MCP for incident response coordination._`;

    try {
      const result = await slack.chat.postMessage({
        channel: channel_id,
        text,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, ts: result.ts }),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: err?.data?.error || err?.message || "unknown_error",
            }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ====================================================================
// TOOL 3: notify_oncall_engineer
// ====================================================================
server.registerTool(
  "notify_oncall_engineer",
  {
    title: "Notify On-call Engineer",
    description:
      "Invites the on-call engineer to the escalation channel and posts " +
      "a direct notification mentioning them.",
    inputSchema: {
      channel_id: z.string(),
      incident_id: z.string(),
      severity: z.string(),
    },
  },
  async ({ channel_id, incident_id, severity }) => {
    const oncallUserId = process.env.ONCALL_USER_ID;

    if (!oncallUserId) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: "ONCALL_USER_ID not set in .env.local",
            }),
          },
        ],
        isError: true,
      };
    }

    try {
      // Invite the on-call engineer to the channel (ignore "already_in_channel")
      try {
        await slack.conversations.invite({
          channel: channel_id,
          users: oncallUserId,
        });
      } catch (inviteErr: any) {
        if (inviteErr?.data?.error !== "already_in_channel") {
          throw inviteErr;
        }
      }

      const result = await slack.chat.postMessage({
        channel: channel_id,
        text:
          `<@${oncallUserId}> you've been paged for *${incident_id}* ` +
          `(severity: *${severity}*). Please acknowledge and join this channel.`,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, ts: result.ts, notified: oncallUserId }),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: err?.data?.error || err?.message || "unknown_error",
            }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ====================================================================
// START SERVER (stdio transport)
// ====================================================================
(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
})();
