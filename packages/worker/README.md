# @contextline/worker

Durable, verified lifecycle propagation for registered AI derivatives.

This package is part of the [ContextLine repository](../../README.md). It provides the lifecycle worker, PostgreSQL/pgvector/Redis connectors, and an environment-driven worker CLI. It is workspace-local in v0.1.0 and has not been published to npm.

```ts
import { LifecycleWorker, RedisConnector } from '@contextline/worker';
const worker = new LifecycleWorker({ registry, tenants: ['acme-corp'], connectors: { answers: new RedisConnector(redis) } });
worker.start();
```

Connector success is not enough: the worker verifies storage state, retries failures, fences stale leases, and records durable evidence. See [connectors](../../docs/connectors.md), [deployment](../../docs/deployment.md), and [operations](../../docs/operations.md).

License: Apache-2.0. See [LICENSE](LICENSE) and the repository [NOTICE](../../NOTICE).
