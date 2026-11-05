# @costgraph/computesdk

A [ComputeSDK](https://github.com/computesdk/computesdk) provider that sends each new sandbox to the cheapest of your providers for its size, and reports each sandbox's start and stop to CostGraph so you can see sandbox cost per agent, run and customer.

You keep your own vendor accounts and keys. They stay in your process and are never sent to CostGraph.

## Install

```sh
npm install @costgraph/computesdk computesdk
```

Requires `computesdk` 4.1.15 or later, Node.js 18 or later, or any runtime with a global `fetch`.

## Use

Move your providers inside `costgraph()`. Every other ComputeSDK call stays the same.

```ts
import { compute } from 'computesdk';
import { e2b } from '@computesdk/e2b';
import { daytona } from '@computesdk/daytona';
import { costgraph } from '@costgraph/computesdk';

compute.setConfig({
  provider: costgraph({
    apiKey: process.env.COSTGRAPH_API_KEY,
    providers: [e2b({ apiKey: E2B_KEY }), daytona({ apiKey: DAYTONA_KEY })],
  }),
});

const sandbox = await compute.instances.create({
  sizeClass: 'md',
  metadata: { agent: 'researcher', run: runId, customer: tenantId },
});
```

`instances.create` asks CostGraph which provider to use, creates the sandbox through that provider and reports the start. `getById`, `list` and `destroy`, along with snapshots and volumes, go straight to the provider that owns the sandbox. `destroy` also reports the stop, whether you call `compute.instances.destroy(id)` or `sandbox.destroy()`.

The `metadata` you pass to `create()` is how CostGraph attributes cost. Providers that forward metadata to the vendor (E2B metadata, Daytona labels) keep doing so.

### Flush on shutdown

Start and stop reports are sent in the background, and their timers do not hold your process open. Before the process exits, wait for anything still queued. `flush()` resolves within 10 seconds by default; pass a different limit in milliseconds to fit your shutdown grace period.

```ts
const cg = costgraph({ apiKey: process.env.COSTGRAPH_API_KEY, providers: [e2b({ apiKey: E2B_KEY })] });
compute.setConfig({ provider: cg });

process.on('SIGTERM', async () => {
  await cg.flush(5_000);
  process.exit(0);
});
```

On edge runtimes such as Cloudflare Workers, background work stops when the response is sent, so hand the flush to the runtime: `ctx.waitUntil(cg.flush())`.

A sandbox that ends without `destroy()`, for example when the vendor's own timeout stops it, is not reported as stopped.

## How a provider is chosen

- With `sizeClass`, CostGraph picks the cheapest of your providers that supports that size. A provider supports a size when its ComputeSDK adapter maps that size class. If none of your providers maps it, `create()` throws the same `InstanceSizeError` that ComputeSDK throws without CostGraph.
- Without `sizeClass`, CostGraph picks among all your providers.
- A create waits at most `routeTimeoutMs` (300 ms by default) for an answer. If CostGraph is slow, unreachable or returns an error, the sandbox is created in the order of your `providers` list, as ComputeSDK does today. CostGraph problems never make a create fail.
- Answers are reused for `cacheTtlMs` (5 minutes by default) per size class and provider list, so most creates make no extra call.
- If the chosen provider fails, the next one is tried only when ComputeSDK would try it: never for a create with `sizeClass`, never after an abort, never for an error the provider marks as not safe to retry, and never when `fallbackOnError` is `false`. Otherwise the next provider in CostGraph's order is tried, followed by any of your providers that the answer did not list.
- An answer that arrives after the timeout is still kept for the next create. After a failed call, creates use list order for 30 seconds before asking again.
- A create from a snapshot or with volumes that CostGraph saw created or listed goes to the provider that holds them.

### Choosing the provider yourself

`compute.instances.create({ provider: 'e2b' })` only knows the `costgraph` provider. To skip routing for one sandbox, call the `costgraph()` provider directly. The start and stop are still reported.

```ts
const sandbox = await cg.instances.create({ provider: 'e2b', metadata: { agent: 'researcher' } });
```

## Options

| Option | Default | Description |
|---|---|---|
| `apiKey` | required | Your CostGraph API key. If it is empty, sandboxes are created in list order and nothing is reported. |
| `providers` | required | Your ComputeSDK providers. Each must have a unique `name`. |
| `baseUrl` | `https://api.costgraph.ai` | CostGraph API address. |
| `tenantId` | none | Sent as the `X-CostGraph-Tenant-ID` header. |
| `routeTimeoutMs` | `300` | Longest a create waits for a routing answer. |
| `cacheTtlMs` | `300000` | How long a routing answer is reused. |
| `fetch` | global `fetch` | Custom `fetch` implementation. |
| `onError` | ignore | Called with any CostGraph error, for logging. Errors never reach your sandbox calls. |
| `fallbackOnError` | `true` | Set to `false` to never try another provider after a failed create. ComputeSDK's own `fallbackOnError` setting does not reach a wrapped provider, so set it here. |

## What leaves your process

Only these are sent to CostGraph:

- your CostGraph API key, in the `Authorization` header
- the names of your providers, such as `e2b` and `daytona`
- the size class of each create
- for each sandbox: provider name, sandbox ID, start and stop times, and the routing decision ID
- the `metadata` you pass to `create()`: string values only, at most 20 keys, keys up to 64 bytes, values cut to 256 bytes

Vendor keys, code, commands, environment variables, files and output are never sent.

Reports are sent in batches of up to 100, at least every 2 seconds. Failed sends are retried a few times and then dropped. At most 10,000 reports are queued; beyond that the oldest are dropped.

## Other languages

The package is a thin client of two REST endpoints. From Python or any other language, call them directly. Responses wrap their payload in `data`.

Choose a provider:

```sh
curl https://api.costgraph.ai/api/v1/tenant/sandboxes/route \
  -H "Authorization: Bearer $COSTGRAPH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"size_class": "md", "providers": ["e2b", "daytona"]}'
```

```json
{
  "data": {
    "decision_id": "6f1c2a9e-0b7d-4c41-9a53-2f7f4f0f9b11",
    "provider": "daytona",
    "order": ["daytona", "e2b"],
    "reason": "cheapest",
    "candidates": []
  }
}
```

Try the providers in `order`. Leave out `size_class` to choose among all providers. Use a short timeout and fall back to your own order if the call fails.

Report sandboxes starting and stopping, up to 100 events per call:

```sh
curl https://api.costgraph.ai/api/v1/tenant/sandboxes/events \
  -H "Authorization: Bearer $COSTGRAPH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [
      {
        "type": "started",
        "provider": "daytona",
        "sandbox_id": "sbx_123",
        "at": "2026-11-05T12:00:00Z",
        "decision_id": "6f1c2a9e-0b7d-4c41-9a53-2f7f4f0f9b11",
        "size_class": "md",
        "metadata": { "agent": "researcher", "run": "run-42", "customer": "acme" }
      },
      { "type": "stopped", "provider": "daytona", "sandbox_id": "sbx_123", "at": "2026-11-05T12:07:30Z" }
    ]
  }'
```

Add `-H "X-CostGraph-Tenant-ID: <tenant>"` to either call to act for a specific tenant.

## License

MIT
