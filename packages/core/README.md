# @contextline/core

Fail-closed source authorization and versioned provenance registry for AI derivatives.

This package is part of the [ContextLine repository](../../README.md). It provides the TypeScript SDK, PostgreSQL registry, migrations, and migration CLI. It is workspace-local in v0.1.0 and has not been published to npm.

```ts
import { ContextLine, PostgresRegistry, createPool } from '@contextline/core';
const ctx = new ContextLine(new PostgresRegistry(createPool({ connectionString: process.env.DATABASE_URL })));
```

Start with the repository [quickstart](../../docs/quickstart.md), [API reference](../../docs/api.md), and [security model](../../docs/security.md). The registry stores metadata only, but identifiers can still be sensitive. Use a dedicated non-owner `NOSUPERUSER NOBYPASSRLS` runtime role.

License: Apache-2.0. See [LICENSE](LICENSE) and the repository [NOTICE](../../NOTICE).
