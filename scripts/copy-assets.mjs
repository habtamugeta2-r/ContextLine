import { cp, mkdir, copyFile } from 'node:fs/promises';
await mkdir('packages/core/dist/migrations', { recursive: true });
await cp('packages/core/src/migrations', 'packages/core/dist/migrations', { recursive: true });
await cp('apps/demo/src/public', 'apps/demo/dist/public', { recursive: true });
for (const pkg of ['packages/core', 'packages/worker']) {
  await copyFile('LICENSE', `${pkg}/LICENSE`);
}
