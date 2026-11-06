# Microsandbox example

Creates one Microsandbox cloud sandbox through `costgraph()`, runs `node --version` in it, and destroys it. CostGraph records the sandbox's start and stop with the `agent`, `run` and `customer` tags.

## Run it

You need Node.js 22 or later, a CostGraph API key with the `sandbox:route` scope, and a Microsandbox API key.

```sh
cp .env.example .env
```

Put your keys in `.env`, then:

```sh
npm install
npm start
```

The sandbox shows up in CostGraph under AutoPilot, on the Sandboxes tab.
