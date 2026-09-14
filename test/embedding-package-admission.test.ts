import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

it('loads the declared embedding package from an isolated installed dependency tree', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    "await import('@huggingface/transformers'); process.stdout.write('embedding-package-load-ok');"], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('embedding-package-load-ok');
});
