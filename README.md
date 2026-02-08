# bounty-webhooks

Webhook relay service with **configurable webhook endpoints**, **HMAC signature verification**, and **retry logic with backoff** for AI Bounty Board events. Full **documentation** and **admin API for managing webhooks** included.

## Features

- **Configurable webhook endpoints** — register multiple URLs with per-endpoint event and secret configuration
- **Event types: created/claimed/submitted/completed** — detects `bounty.created`, `bounty.claimed`, `bounty.submitted`, and `bounty.completed` events
- **HMAC signature verification** — signs every payload with SHA-256 HMAC via `X-Signature` header
- **Retry logic with backoff** — 3 retries with exponential backoff (1s, 2s, 4s)
- **Admin API for managing webhooks** — full REST API to list, create, update, and delete webhook registrations
- **Documentation** — complete setup guide, payload examples, and signature verification code samples
- State tracking to avoid duplicate notifications across restarts
- Delivery log for debugging

## Quick Start

```bash
# Copy and configure environment
cp .env.example .env

# Install dependencies
bun install

# Start the service
bun run start
```

## Register a Webhook

```bash
curl -X POST http://localhost:3200/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-server.com/webhook",
    "events": ["bounty.created", "bounty.completed"],
    "secret": "optional-per-endpoint-secret"
  }'
```

## Webhook Payload

Each webhook POST includes these headers:

| Header          | Description                          |
|-----------------|--------------------------------------|
| `X-Signature`   | `sha256=<hmac>` of the JSON body    |
| `X-Event-Type`  | Event type (e.g. `bounty.created`)  |
| `X-Event-Id`    | Unique event identifier              |
| `X-Webhook-Id`  | The webhook endpoint ID              |

Body:

```json
{
  "id": "evt_42_bounty.created_1705312800000",
  "type": "bounty.created",
  "bountyId": 42,
  "data": { "id": 42, "title": "...", "amount": 20, "status": "open", ... },
  "timestamp": "2025-01-15T12:00:00.000Z"
}
```

## Verifying Signatures

```ts
import { createHmac } from "crypto";

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
  return signature === expected;
}
```

## Management API

| Method   | Path               | Description                    |
|----------|--------------------|--------------------------------|
| `GET`    | `/webhooks`        | List all webhooks              |
| `POST`   | `/webhooks`        | Register a new webhook         |
| `GET`    | `/webhooks/:id`    | Get a specific webhook         |
| `PATCH`  | `/webhooks/:id`    | Update a webhook               |
| `DELETE` | `/webhooks/:id`    | Delete a webhook               |
| `GET`    | `/deliveries`      | View delivery log              |
| `GET`    | `/health`          | Service health check           |

## Configuration

| Variable          | Default                         | Description                  |
|-------------------|---------------------------------|------------------------------|
| `API_BASE_URL`    | `https://aibountyboard.com/api` | Bounty board API URL         |
| `POLL_INTERVAL_MS`| `30000`                         | Polling interval             |
| `PORT`            | `3200`                          | Management API port          |
| `HMAC_SECRET`     | `change-me-in-production`       | Default HMAC signing secret  |
| `STATE_FILE`      | `./webhook-state.json`          | State persistence file       |
| `CONFIG_FILE`     | `./webhooks.json`               | Webhook registrations file   |

## License

MIT
