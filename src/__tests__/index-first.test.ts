import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PluginInput } from '../types';
import plugin, { detectServerUrl, resetOpencodeAgentTmuxStateForTest } from '../index';

const originalPort = process.env.OPENCODE_PORT;

afterEach(() => {
  if (originalPort === undefined) {
    delete process.env.OPENCODE_PORT;
  } else {
    process.env.OPENCODE_PORT = originalPort;
  }
});

function createPluginInput(directory: string): PluginInput {
  return {
    directory,
    client: {
      session: {
        status: async () => ({ data: {} }),
        subscribe: () => () => {},
      },
    },
  };
}

test('detectServerUrl respects OPENCODE_PORT when provided', () => {
  process.env.OPENCODE_PORT = '5151';
  expect(detectServerUrl()).toBe('http://localhost:5151');
});

test('plugin initializes, forwards events, and skips duplicate init with real modules', async () => {
  resetOpencodeAgentTmuxStateForTest();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentmux-index-first-'));
  fs.writeFileSync(
    path.join(projectDir, 'opentmux.json'),
    JSON.stringify({ enabled: false }),
  );

  const ctx = createPluginInput(projectDir);
  const first = await plugin(ctx);
  const second = await plugin(ctx);

  expect(typeof first.config).toBe('function');
  expect(typeof first.event).toBe('function');
  expect(typeof first.dispose).toBe('function');
  expect(typeof second.config).toBe('function');
  expect(typeof second.event).toBe('function');
  expect(typeof second.dispose).toBe('function');
  expect(await first.event?.({ event: { type: 'session.created', properties: { info: {} } } })).toBeUndefined();
  expect(await second.event?.({ event: { type: 'session.created', properties: { info: {} } } })).toBeUndefined();

  fs.rmSync(projectDir, { recursive: true, force: true });
});
