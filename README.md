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
  metadata: { agent: 'researcher', run: runId, customer: customerId },
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

A create that a provider refuses is reported as a failed start, with the provider, a failure class (`auth`, `quota`, `capacity`, `timeout` or `other`) and the provider's error message, so CostGraph can rank providers on how often they start for you. A create you abort is not reported.

## Run on your team's CostGraph connections

When the sandbox accounts are connected on CostGraph's Integrations page, `costgraphConnections()` runs sandboxes on them without any vendor key in your process. Use it when you build for a team that connected its own accounts, with an API key or a Sign in with CostGraph access token that carries the `sandbox:run` scope.

```ts
import { compute } from 'computesdk';
import { costgraphConnections } from '@costgraph/computesdk';

compute.setConfig({
  provider: costgraphConnections({ apiKey: process.env.COSTGRAPH_API_KEY, policy: 'cheapest' }),
});

const sandbox = await compute.instances.create({ sizeClass: 'md', metadata: { agent: 'researcher' } });
const { stdout, truncated } = await sandbox.runCommand('python3 task.py', { timeout: 120_000 });
await sandbox.filesystem.writeFile('/tmp/input.json', JSON.stringify(input));
const report = await sandbox.filesystem.readFile('/tmp/report.md');
await sandbox.destroy();
```

- CostGraph picks the provider by the team's routing policy, or by `policy` when you set it, and tries the next provider when a create fails. Pass `provider` to always use one provider.
- Sandboxes are recorded on the team's AutoPilot sandboxes view with their cost, and the provider's own lifecycle ends them; `timeout` on `create()` is passed to the provider.
- `runCommand` returns at most 256 KiB of each output stream, with `truncated: true` when it cut one. `background: true` returns at once.
- `runCommand`, `filesystem.readFile`, `filesystem.writeFile`, `getInfo` and `destroy` are available. Other instance methods, snapshots and volumes are not.
- `instances.list()` returns the running sandboxes created through the API or the CostGraph MCP, and `getById` finds one of them. Workflow and CI sandboxes are not reachable here.

| Option | Default | Description |
|---|---|---|
| `apiKey` | none | A CostGraph API key with the `sandbox:run` scope. Set this or `accessToken`. |
| `accessToken` | none | A Sign in with CostGraph access token, sent as `Authorization: Bearer`. |
| `baseUrl` | `https://api.costgraph.ai` | CostGraph API address. |
| `tenantId` | none | Sent as the `X-CostGraph-Tenant-ID` header. |
| `policy` | team policy | `cheapest`, `balanced` or `fastest` for these sandboxes. |
| `provider` | none | Always create on this connected provider, for example `e2b`. |
| `fetch` | global `fetch` | Custom `fetch` implementation. |

## How a provider is chosen

- With `sizeClass`, CostGraph picks the cheapest of your providers that supports that size (see [Sizes](#sizes)). If none of your providers supports it, `create()` throws the same `InstanceSizeError` that ComputeSDK throws without CostGraph.
- Without `sizeClass`, each provider creates its own default size, so prices are not comparable. The sandbox goes to the first provider in your list, and CostGraph still records its start and stop.
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

## Sizes

`sizeClass` asks for one of ComputeSDK's standard sizes:

| Size | vCPUs | Memory |
|---|---|---|
| `xs` | 1 | 1 GiB |
| `sm` | 1 | 2 GiB |
| `md` | 2 | 4 GiB |
| `lg` | 4 | 8 GiB |
| `xl` | 8 | 16 GiB |
| `2xl` | 16 | 32 GiB |

```ts
import { compute } from 'computesdk';
import { modal } from '@computesdk/modal';
import { vercel } from '@computesdk/vercel';
import { costgraph } from '@costgraph/computesdk';

compute.setConfig({
  provider: costgraph({
    apiKey: process.env.COSTGRAPH_API_KEY,
    providers: [
      modal({ tokenId: MODAL_TOKEN_ID, tokenSecret: MODAL_TOKEN_SECRET }),
      vercel({ token: VERCEL_TOKEN, teamId: VERCEL_TEAM_ID, projectId: VERCEL_PROJECT_ID }),
    ],
  }),
});

const sandbox = await compute.instances.create({
  sizeClass: 'md',
  metadata: { agent: 'researcher', run: runId, customer: customerId },
});
```

A provider supports a size in one of two ways:

- **Native.** The ComputeSDK adapter maps sizes itself, as Archil and Namespace do. The size goes to the adapter unchanged.
- **Mapped.** The adapter does not map sizes yet, but the vendor accepts CPU and memory for each new sandbox. CostGraph turns the size into that vendor's own create options, following the vendor's documented values:

| Provider | Sizes | Create options |
|---|---|---|
| Beam | `xs` to `xl` | `cpu`, `memory` |
| Daytona | `xs` to `lg`, only with `image` | `resources.cpu`, `resources.memory` |
| Modal | `xs` to `2xl` | `cpu` and `cpuLimit` (physical cores, two vCPUs each), `memoryMiB` |
| Northflank | `xs` to `2xl` | `deploymentPlan` (`nf-compute-100-1` to `nf-compute-1600-32`) |
| Runloop | `xs` to `2xl` | `launch_parameters.resource_size_request`, with a custom size from `lg` up |
| Vercel | `xs` to `xl` | `resources.vcpus` |

- Runloop and Vercel have no 1 vCPU / 1 GiB size, so for `xs` they create their smallest size, 1 vCPU with 2 GiB. They are used for `xs` only when none of your other providers creates exactly 1 vCPU / 1 GiB, and CostGraph records the size they created, not `xs`.
- Daytona accepts CPU and memory only for sandboxes built from an image, so pass `image` (for example `image: 'python:3.12'`) together with `sizeClass`. Without `image`, or with `snapshotId` or `templateId`, Daytona does not take part in sized creates. `xl` and `2xl` are above Daytona's default limit of 4 vCPUs and 8 GiB.
- Vercel allows 16 vCPUs only on Enterprise plans, so `2xl` is not sent to Vercel.
- ComputeSDK does not allow CPU or memory options such as `cpu`, `memory`, `resources`, `launch_parameters` or `deploymentPlan` next to `sizeClass`. Other options you pass are kept as they are.

### E2B

E2B fixes CPU and memory per template, not per sandbox, so E2B does not take part in creates with `sizeClass`. To run E2B sandboxes at a given size, build a template with that size using E2B's SDK, then create from it by name without `sizeClass`. CostGraph records these sandboxes without a size, so they are not routed or compared by size:

```ts
await Template.build(template, 'agent-md', { cpuCount: 2, memoryMB: 4096 });

const sandbox = await cg.instances.create({ provider: 'e2b', templateId: 'agent-md', metadata: { agent: 'researcher' } });
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

- your CostGraph API key, in the `X-API-Key` header
- the names of your providers, such as `e2b` and `daytona`
- the size class of each create, or the vCPUs and memory a provider actually received when its nearest size is larger
- for each sandbox: provider name, sandbox ID, the time the create was sent to the provider, start and stop times, and the routing decision ID
- for each create a provider refuses: provider name, time, failure class and the provider's error message, cut to 2,000 bytes
- the `metadata` you pass to `create()`: string values only, at most 20 keys, keys up to 64 bytes, values cut to 256 bytes

Vendor keys, code, commands, environment variables, files and output are never sent.

Reports are sent in batches of up to 100, at least every 2 seconds. Failed sends are retried a few times and then dropped. At most 10,000 reports are queued; beyond that the oldest are dropped.

## Other languages

With your own keys, the package is a thin client of two REST endpoints. From Python or any other language, call them directly. Responses wrap their payload in `data`.

Choose a provider:

```sh
curl https://api.costgraph.ai/api/v1/tenant/sandboxes/route \
  -H "X-API-Key: $COSTGRAPH_API_KEY" \
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

Try the providers in `order`. Without `size_class` (or `vcpus` and `memory_mib`), `order` is your own list and `reason` is `no_size`. Use a short timeout and fall back to your own order if the call fails.

Report sandboxes starting and stopping, up to 100 events per call:

```sh
curl https://api.costgraph.ai/api/v1/tenant/sandboxes/events \
  -H "X-API-Key: $COSTGRAPH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [
      {
        "type": "started",
        "provider": "daytona",
        "sandbox_id": "sbx_123",
        "at": "2026-11-05T12:00:00Z",
        "create_requested_at": "2026-11-05T11:59:58Z",
        "decision_id": "6f1c2a9e-0b7d-4c41-9a53-2f7f4f0f9b11",
        "size_class": "md",
        "metadata": { "agent": "researcher", "run": "run-42", "customer": "acme" }
      },
      { "type": "stopped", "provider": "daytona", "sandbox_id": "sbx_123", "at": "2026-11-05T12:07:30Z", "reason": "destroyed" },
      {
        "type": "failed",
        "provider": "e2b",
        "at": "2026-11-05T11:59:57Z",
        "decision_id": "6f1c2a9e-0b7d-4c41-9a53-2f7f4f0f9b11",
        "failure_class": "capacity",
        "detail": "no capacity in region"
      }
    ]
  }'
```

`create_requested_at` is when the create was sent to the provider, so CostGraph can measure how long the provider took to start it. A `failed` event needs no `sandbox_id`.

When a sandbox's size is not one of the standard sizes, send `vcpus` and `memory_mib` in the `started` event instead of `size_class`.

Add `-H "X-CostGraph-Tenant-ID: <tenant>"` to either call to act for a specific tenant.

## License

MIT
