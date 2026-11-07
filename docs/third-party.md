# Third-party notices

ContextLine itself is licensed under Apache-2.0; see [LICENSE](../LICENSE) and [NOTICE](../NOTICE). Dependencies retain their own licenses. This file summarizes direct dependencies observed in the lockfile at v0.1.0; it is not a substitute for reviewing transitive license texts when redistributing binaries or containers.

## Runtime dependencies

| Package | Version | License | Use |
|---|---|---|---|
| `pg` | 8.23.1 | MIT | PostgreSQL client/pool for core, worker, demo |
| `ioredis` | 5.11.1 | MIT | Redis connector and worker CLI |

`pg` is used in JavaScript mode; optional native `pg-native` is not installed. Transitive packages are recorded in `package-lock.json`. Review their license files in `node_modules` or the distributed image before redistribution.

## Development/test dependencies

| Package | Version | License | Use |
|---|---|---|---|
| `typescript` | 5.9.3 | Apache-2.0 | Build/type checking |
| `tsx` | 4.23.15 | MIT | TypeScript test/script runner |
| `@types/node` | 22.20.3 | MIT | Node.js type declarations |
| `@types/pg` | 8.23.1 | MIT | PostgreSQL type declarations |
| `@embedded-postgres/linux-x64` | 17.9.0-beta.17 | MIT (wrapper package) | Local demo/test PostgreSQL binaries |

The embedded package distributes PostgreSQL binaries; PostgreSQL itself is under the PostgreSQL License. The wrapper's MIT license does not replace the database's license notices. The demo/test helper uses these binaries locally; the production Dockerfile uses the official Node.js base image and does not bundle the embedded PostgreSQL package in the runtime stage.

## Container and CI images

- `node:22-bookworm-slim` base image: review Debian/Node/image license notices when distributing the image.
- `pgvector/pgvector:pg17` and `redis:7-alpine` CI/Compose services: PostgreSQL/pgvector/Redis and base-image licenses apply to those services. They are not vendored into the ContextLine source tree.

## Frontend assets

The dashboard uses browser-native JavaScript/CSS, system fonts, and locally authored SVG icons. It does not load a frontend framework, external font CDN, analytics script, or stock image service.

## Updating this notice

When changing dependencies, run `npm ls --all`, inspect license fields/texts, update the lockfile, and revise this summary. Do not assume a permissive direct dependency implies every transitive or binary component has the same license.
