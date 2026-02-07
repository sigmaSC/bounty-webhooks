/**
 * AI Bounty Board Webhook Relay Service
 *
 * Polls the bounty board API, detects events (created, claimed, submitted, completed),
 * and sends POST requests to configured webhook endpoints with HMAC signatures.
 *
 * Run: bun run index.ts
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { createHmac } from "crypto";

// --- Configuration ---
const API_BASE = process.env.API_BASE_URL || "https://bounty.owockibot.xyz";
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL_MS) || 30_000;
const PORT = Number(process.env.PORT) || 3200;
const HMAC_SECRET = process.env.HMAC_SECRET || "change-me-in-production";
const STATE_FILE = process.env.STATE_FILE || "./webhook-state.json";
const CONFIG_FILE = process.env.CONFIG_FILE || "./webhooks.json";
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

// --- Types ---
interface WebhookEndpoint {
  id: string;
  url: string;
  events: EventType[];
  active: boolean;
  secret?: string; // Per-endpoint secret override
  createdAt: string;
}

type EventType = "bounty.created" | "bounty.claimed" | "bounty.submitted" | "bounty.completed";

interface WebhookEvent {
  id: string;
  type: EventType;
  bountyId: number;
  data: Record<string, unknown>;
  timestamp: string;
}

interface BountySnapshot {
  id: number;
  status: string;
  claimedBy: string | null;
  submittedAt: string | null;
  completedAt: string | null;
}

interface StateData {
  knownBounties: Record<number, BountySnapshot>;
  deliveryLog: DeliveryLogEntry[];
}

interface DeliveryLogEntry {
  eventId: string;
  endpointId: string;
  status: "success" | "failed";
  attempts: number;
  lastAttempt: string;
  statusCode?: number;
}

// --- State ---
let state: StateData = { knownBounties: {}, deliveryLog: [] };
let webhookEndpoints: WebhookEndpoint[] = [];

// --- Persistence ---
function loadState(): void {
  if (existsSync(STATE_FILE)) {
    try {
      state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    } catch {
      state = { knownBounties: {}, deliveryLog: [] };
    }
  }
}

function saveState(): void {
  // Keep only last 1000 delivery log entries
  if (state.deliveryLog.length > 1000) {
    state.deliveryLog = state.deliveryLog.slice(-1000);
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadWebhooks(): void {
  if (existsSync(CONFIG_FILE)) {
    try {
      webhookEndpoints = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    } catch {
      webhookEndpoints = [];
    }
  }
}

function saveWebhooks(): void {
  writeFileSync(CONFIG_FILE, JSON.stringify(webhookEndpoints, null, 2));
}

// --- HMAC Signing ---
function signPayload(payload: string, secret?: string): string {
  return createHmac("sha256", secret || HMAC_SECRET).update(payload).digest("hex");
}

// --- Event Detection ---
function detectEvents(
  oldSnapshot: BountySnapshot | undefined,
  newBounty: Record<string, unknown>
): EventType[] {
  const events: EventType[] = [];
  const id = newBounty.id as number;
  const status = newBounty.status as string;

  if (!oldSnapshot) {
    events.push("bounty.created");
    // If it was already claimed/submitted/completed at discovery, emit those too
    if (status === "claimed") events.push("bounty.claimed");
    if (status === "submitted") events.push("bounty.submitted");
    if (status === "completed") events.push("bounty.completed");
    return events;
  }

  if (oldSnapshot.status !== "claimed" && status === "claimed") {
    events.push("bounty.claimed");
  }
  if (oldSnapshot.status !== "submitted" && status === "submitted") {
    events.push("bounty.submitted");
  }
  if (oldSnapshot.status !== "completed" && status === "completed") {
    events.push("bounty.completed");
  }

  return events;
}

// --- Webhook Delivery ---
async function deliverWebhook(
  endpoint: WebhookEndpoint,
  event: WebhookEvent
): Promise<boolean> {
  const payload = JSON.stringify(event);
  const signature = signPayload(payload, endpoint.secret);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature": `sha256=${signature}`,
          "X-Event-Type": event.type,
          "X-Event-Id": event.id,
          "X-Webhook-Id": endpoint.id,
        },
        body: payload,
      });

      const entry: DeliveryLogEntry = {
        eventId: event.id,
        endpointId: endpoint.id,
        status: res.ok ? "success" : "failed",
        attempts: attempt,
        lastAttempt: new Date().toISOString(),
        statusCode: res.status,
      };
      state.deliveryLog.push(entry);

      if (res.ok) {
        console.log(`[OK] Delivered ${event.type} to ${endpoint.url} (attempt ${attempt})`);
        return true;
      }

      console.warn(`[WARN] ${endpoint.url} returned ${res.status}, attempt ${attempt}/${MAX_RETRIES}`);
    } catch (err) {
      console.error(`[ERR] Failed to deliver to ${endpoint.url}, attempt ${attempt}/${MAX_RETRIES}:`, err);
    }

    // Exponential backoff
    if (attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  state.deliveryLog.push({
    eventId: event.id,
    endpointId: endpoint.id,
    status: "failed",
    attempts: MAX_RETRIES,
    lastAttempt: new Date().toISOString(),
  });

  return false;
}

// --- Polling ---
async function pollAndDispatch(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/bounties`);
    if (!res.ok) {
      console.error(`API returned ${res.status}`);
      return;
    }

    const bounties = (await res.json()) as Record<string, unknown>[];

    for (const bounty of bounties) {
      const id = bounty.id as number;
      const old = state.knownBounties[id];
      const events = detectEvents(old, bounty);

      // Update snapshot
      state.knownBounties[id] = {
        id,
        status: bounty.status as string,
        claimedBy: (bounty.claimedBy as string) || null,
        submittedAt: (bounty.submittedAt as string) || null,
        completedAt: (bounty.completedAt as string) || null,
      };

      // Dispatch events
      for (const eventType of events) {
        const event: WebhookEvent = {
          id: `evt_${id}_${eventType}_${Date.now()}`,
          type: eventType,
          bountyId: id,
          data: bounty,
          timestamp: new Date().toISOString(),
        };

        // Send to all active endpoints subscribing to this event type
        const targets = webhookEndpoints.filter(
          (ep) => ep.active && ep.events.includes(eventType)
        );

        for (const target of targets) {
          await deliverWebhook(target, event);
        }
      }
    }

    saveState();
  } catch (err) {
    console.error("Polling error:", err);
  }
}

// --- Helper ---
function generateId(): string {
  return `wh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// --- HTTP Server (Webhook Management API) ---
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;

    // List all webhook endpoints
    if (method === "GET" && url.pathname === "/webhooks") {
      return Response.json(webhookEndpoints);
    }

    // Register a new webhook endpoint
    if (method === "POST" && url.pathname === "/webhooks") {
      try {
        const body = await req.json();
        const { url: hookUrl, events, secret } = body as {
          url: string;
          events: EventType[];
          secret?: string;
        };

        if (!hookUrl || !events || !Array.isArray(events)) {
          return Response.json({ error: "url and events[] are required" }, { status: 400 });
        }

        const validEvents: EventType[] = [
          "bounty.created",
          "bounty.claimed",
          "bounty.submitted",
          "bounty.completed",
        ];
        const invalidEvents = events.filter((e) => !validEvents.includes(e));
        if (invalidEvents.length > 0) {
          return Response.json(
            { error: `Invalid events: ${invalidEvents.join(", ")}. Valid: ${validEvents.join(", ")}` },
            { status: 400 }
          );
        }

        const endpoint: WebhookEndpoint = {
          id: generateId(),
          url: hookUrl,
          events,
          active: true,
          secret,
          createdAt: new Date().toISOString(),
        };

        webhookEndpoints.push(endpoint);
        saveWebhooks();

        return Response.json(endpoint, { status: 201 });
      } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }
    }

    // Get a specific webhook
    if (method === "GET" && url.pathname.startsWith("/webhooks/")) {
      const id = url.pathname.split("/")[2];
      const endpoint = webhookEndpoints.find((ep) => ep.id === id);
      if (!endpoint) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json(endpoint);
    }

    // Update a webhook
    if (method === "PATCH" && url.pathname.startsWith("/webhooks/")) {
      const id = url.pathname.split("/")[2];
      const idx = webhookEndpoints.findIndex((ep) => ep.id === id);
      if (idx < 0) return Response.json({ error: "Not found" }, { status: 404 });

      try {
        const body = await req.json();
        const updates = body as Partial<WebhookEndpoint>;

        if (updates.url) webhookEndpoints[idx].url = updates.url;
        if (updates.events) webhookEndpoints[idx].events = updates.events;
        if (updates.active !== undefined) webhookEndpoints[idx].active = updates.active;
        if (updates.secret !== undefined) webhookEndpoints[idx].secret = updates.secret;

        saveWebhooks();
        return Response.json(webhookEndpoints[idx]);
      } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }
    }

    // Delete a webhook
    if (method === "DELETE" && url.pathname.startsWith("/webhooks/")) {
      const id = url.pathname.split("/")[2];
      const idx = webhookEndpoints.findIndex((ep) => ep.id === id);
      if (idx < 0) return Response.json({ error: "Not found" }, { status: 404 });

      webhookEndpoints.splice(idx, 1);
      saveWebhooks();
      return new Response(null, { status: 204 });
    }

    // Delivery log
    if (method === "GET" && url.pathname === "/deliveries") {
      const limit = Number(url.searchParams.get("limit")) || 50;
      return Response.json(state.deliveryLog.slice(-limit));
    }

    // Service health
    if (method === "GET" && url.pathname === "/health") {
      return Response.json({
        status: "ok",
        registeredWebhooks: webhookEndpoints.length,
        activeWebhooks: webhookEndpoints.filter((e) => e.active).length,
        trackedBounties: Object.keys(state.knownBounties).length,
        totalDeliveries: state.deliveryLog.length,
      });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

// --- Start ---
loadState();
loadWebhooks();

console.log(`Webhook Relay running on http://localhost:${PORT}`);
console.log(`Monitoring: ${API_BASE}`);
console.log(`Polling every ${POLL_INTERVAL / 1000}s`);
console.log(`Registered webhooks: ${webhookEndpoints.length}`);

// Initial poll
pollAndDispatch();

// Schedule periodic polling
setInterval(pollAndDispatch, POLL_INTERVAL);
