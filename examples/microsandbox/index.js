import { microsandbox } from '@computesdk/microsandbox';
import { costgraph } from '@costgraph/computesdk';
import { compute } from 'computesdk';

const cg = costgraph({
  apiKey: process.env.COSTGRAPH_API_KEY,
  baseUrl: process.env.COSTGRAPH_BASE_URL,
  providers: [microsandbox({ apiKey: process.env.MSB_API_KEY, image: 'node:22' })],
  onError: error => console.error('CostGraph:', error),
});

compute.setConfig({ provider: cg });

const sandbox = await compute.instances.create({
  metadata: { agent: 'example', run: `example-${Date.now()}`, customer: 'example-customer' },
});
console.log(`Created ${sandbox.instanceId} on ${sandbox.provider}`);

try {
  const result = await sandbox.runCommand('node --version');
  console.log(`node --version: ${result.stdout.trim()}`);
} finally {
  await sandbox.destroy();
  await cg.flush();
  console.log('Destroyed the sandbox and sent its start and stop to CostGraph');
}
