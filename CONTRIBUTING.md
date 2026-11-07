# Contributing

Thanks for helping improve ContextLine. This project treats security semantics and evidence as part of the product, not as after-the-fact marketing.

## Development setup

```bash
npm ci
npm run build
npm run check
npm run demo
```

Node.js 22+ is required. The zero-configuration demo/test clusters use Linux-x64 PostgreSQL binaries; on other platforms, run unit tests/build and use an external PostgreSQL instance or CI for integration work.

## Change expectations

1. Keep changes scoped and explain the security/operational impact.
2. Add a regression test for security-relevant fixes. Prefer real PostgreSQL tests for locking, RLS, grants, and transaction behavior.
3. Do not weaken a failing security assertion merely to make CI pass. Decide whether the code or the documented invariant is wrong and update both deliberately.
4. Keep registry content metadata-only, but remember identifiers can still be sensitive.
5. Preserve tenant-inclusive keys, forced RLS, least-privilege grants, and fail-closed defaults.
6. Connector changes need tenant-boundary, idempotence, false-verification, and timeout-after-side-effect tests.
7. Add migrations; never edit an applied migration. Update runtime grants deliberately when schema changes.
8. Update docs and [validation](docs/validation.md) when behavior or measured results change. Do not report skipped live tests as passes.
9. Run `npm run check` and, when relevant, `npm run test:live`, `npm run demo:cli`, and `npm run benchmark`.

## Code style

- Strict TypeScript, ESM, explicit error codes, parameterized SQL.
- Small focused modules; no unnecessary framework or runtime dependency.
- Browser demo assets remain local and dependency-free unless a change is justified.
- Follow `.editorconfig`. Keep secrets, `.contextline/`, build output, and `node_modules/` out of Git.

## Documentation and research

Separate verified facts, local measurements, design decisions, and hypotheses. Cite primary sources where possible. Do not invent market size, customer demand, competitor revenue, compliance guarantees, or latency SLAs. Corrections to the original thesis belong in the research/decision records.

## Security reports

Do not open a public issue containing exploit details or sensitive data. Follow [SECURITY.md](SECURITY.md).

## License

Contributions are accepted under the repository's Apache-2.0 license unless explicitly stated otherwise. Ensure you have the right to submit the contribution and update third-party notices when adding dependencies.
