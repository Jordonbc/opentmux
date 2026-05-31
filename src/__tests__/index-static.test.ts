import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import plugin, { detectServerUrl } from '../index';

const originalPort = process.env.OPENCODE_PORT;

afterEach(() => {
  if (originalPort === undefined) {
    delete process.env.OPENCODE_PORT;
  } else {
    process.env.OPENCODE_PORT = originalPort;
  }
});

test('detectServerUrl falls back to the default port', () => {
  delete process.env.OPENCODE_PORT;

  expect(detectServerUrl()).toBe('http://localhost:4096');
});

test('plugin covers duplicate init using static imports', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentmux-index-'));
  fs.writeFileSync(
    path.join(projectDir, 'opentmux.json'),
    JSON.stringify({ enabled: false }),
  );

  delete process.env.OPENCODE_PORT;

  const ctx = {
    directory: projectDir,
    client: {
      session: {
        status: async () => ({ data: {} }),
        subscribe: () => () => {},
      },
    },
  };

  const first = await plugin(ctx);
  const second = await plugin(ctx);

  expect(first.name).toBe('opentmux');
  expect(second.name).toBe('opentmux');
  expect(await first.event?.({ event: { type: 'session.created', properties: {} } })).toBeUndefined();
  expect(await second.event?.({ event: { type: 'session.created', properties: {} } })).toBeUndefined();

  fs.rmSync(projectDir, { recursive: true, force: true });
});
