/**
 * MCP Client Helper
 * -----------------------------------------------------------------------
 * This module connects to the MCP Escalation Server (mcp-escalation-server.ts)
 * over stdio and exposes a single high-level function, `escalateIncident`,
 * that orchestrates 3 MCP tool calls:
 *
 *   1. create_escalation_channel  -> creates a dedicated Slack channel
 *   2. post_incident_briefing     -> posts incident context + history
 *   3. notify_oncall_engineer     -> pages the on-call engineer
 *
 * The MCP server process is spawned once and reused for subsequent calls.
 * -----------------------------------------------------------------------
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let mcpClient: Client | null = null;
let connecting: Promise<Client> | null = null;

async function getMcpClient(): Promise<Client> {
  if (mcpClient) return mcpClient;
  if (connecting) return connecting;

  connecting = (async () => {
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["ts-node", "src/mcp-escalation-server.ts"],
    });

    const client = new Client({ name: "incident-agent", version: "1.0.0" });
    await client.connect(transport);
    mcpClient = client;
    return client;
  })();

  return connecting;
}

export interface SimilarIncidentInput {
  title: string;
  time_ago: string;
  resolved_in?: string;
  resolution: string;
}

export interface EscalationInput {
  incident_id: string;
  severity: string;
  service: string;
  confidence?: number;
  original_message: string;
  similar_incidents?: SimilarIncidentInput[];
}

export interface EscalationResult {
  ok: boolean;
  channel_id?: string;
  channel_name?: string;
  error?: string;
}

function parseToolResult(result: any): any {
  const block = result?.content?.[0];
  if (!block || block.type !== "text") {
    return { ok: false, error: "unexpected_mcp_response" };
  }
  try {
    return JSON.parse(block.text);
  } catch {
    return { ok: false, error: "invalid_mcp_response" };
  }
}

/**
 * Escalates an incident via MCP:
 * creates a channel, posts a briefing, and pages the on-call engineer.
 */
export async function escalateIncident(
  input: EscalationInput
): Promise<EscalationResult> {
  const client = await getMcpClient();

  // Step 1: create the escalation channel
  const createResult = await client.callTool({
    name: "create_escalation_channel",
    arguments: {
      incident_id: input.incident_id,
      service: input.service,
    },
  });
  const createData = parseToolResult(createResult);

  if (!createData.ok) {
    return { ok: false, error: createData.error };
  }

  const channel_id = createData.channel_id as string;
  const channel_name = createData.channel_name as string;

  // Step 2: post the incident briefing into the new channel
  await client.callTool({
    name: "post_incident_briefing",
    arguments: {
      channel_id,
      incident_id: input.incident_id,
      severity: input.severity,
      service: input.service,
      confidence: input.confidence,
      original_message: input.original_message,
      similar_incidents: input.similar_incidents ?? [],
    },
  });

  // Step 3: notify the on-call engineer
  await client.callTool({
    name: "notify_oncall_engineer",
    arguments: {
      channel_id,
      incident_id: input.incident_id,
      severity: input.severity,
    },
  });

  return { ok: true, channel_id, channel_name };
}
