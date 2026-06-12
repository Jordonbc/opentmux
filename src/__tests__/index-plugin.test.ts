import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

import type { TmuxConfig } from '../config';
import type { PluginInput } from '../types';

const logMock = mock(() => {});
const startTmuxCheckMock = mock(() => {});
const loadConfigMock = mock(() => ({
  enabled: true,
  layout: 'main-vertical',
  main_pane_size: 60,
  auto_close: true,
  spawn_delay_ms: 0,
  max_retry_attempts: 2,
  layout_debounce_ms: 150,
  max_agents_per_column: 3,
  reaper_enabled: false,
  reaper_interval_ms: 30000,
  reaper_min_zombie_checks: 3,
  reaper_grace_period_ms: 5000,
  reaper_auto_self_destruct: true,
  reaper_self_destruct_timeout_ms: 600000,
  rotate_port: false,
  max_ports: 10,
}));

const onSessionCreatedMock = mock(async () => {});
const constructorCalls: Array<{
  ctx: { directory: string; serverUrl?: URL | string };
  tmuxConfig: TmuxConfig;
  serverUrl: string;
}> = [];

class MockTmuxSessionManager {
  constructor(
    ctx: { directory: string; serverUrl?: URL | string },
    tmuxConfig: TmuxConfig,
    serverUrl: string,
  ) {
    constructorCalls.push({ ctx, tmuxConfig, serverUrl });
  }

  onSessionCreated = onSessionCreatedMock;
}

function createPluginInput(directory: string, serverUrl?: string | URL): PluginInput {
  return {
    directory,
    serverUrl,
    client: {
      session: {
        status: async () => ({ data: {} }),
        subscribe: () => () => {},
      },
    },
  };
}

async function importPlugin() {
  return import('../index');
}

beforeEach(() => {
  constructorCalls.length = 0;
  mock.clearAllMocks();
  mock.module('../utils/config-loader', () => ({
    loadConfig: loadConfigMock,
  }));
  mock.module('../utils', () => ({
    log: logMock,
    startTmuxCheck: startTmuxCheckMock,
  }));
  mock.module('../tmux-session-manager', () => ({
    TmuxSessionManager: MockTmuxSessionManager,
  }));
});

afterEach(() => {
  mock.restore();
});

test('plugin initializes manager, starts tmux check, and forwards events', async () => {
  loadConfigMock.mockReturnValueOnce({
    enabled: true,
    layout: 'main-horizontal',
    main_pane_size: 72,
    auto_close: false,
    spawn_delay_ms: 11,
    max_retry_attempts: 7,
    layout_debounce_ms: 250,
    max_agents_per_column: 4,
    reaper_enabled: false,
    reaper_interval_ms: 123,
    reaper_min_zombie_checks: 9,
    reaper_grace_period_ms: 1111,
    reaper_auto_self_destruct: false,
    reaper_self_destruct_timeout_ms: 2222,
    rotate_port: true,
    max_ports: 20,
  });

  const { default: plugin, resetOpencodeAgentTmuxStateForTest } = await importPlugin();
  resetOpencodeAgentTmuxStateForTest();
  const ctx = createPluginInput('/work', new URL('http://localhost:7777'));

  const output = await plugin(ctx);

  expect(typeof output.config).toBe('function');
  expect(typeof output.event).toBe('function');
  expect(typeof output.dispose).toBe('function');
  expect(constructorCalls).toHaveLength(1);
  expect(constructorCalls[0]).toEqual({
    ctx,
    tmuxConfig: {
      enabled: true,
      layout: 'main-horizontal',
      main_pane_size: 72,
      auto_close: false,
      spawn_delay_ms: 11,
      max_retry_attempts: 7,
      layout_debounce_ms: 250,
      max_agents_per_column: 4,
      reaper_enabled: false,
      reaper_interval_ms: 123,
      reaper_min_zombie_checks: 9,
      reaper_grace_period_ms: 1111,
      reaper_auto_self_destruct: false,
      reaper_self_destruct_timeout_ms: 2222,
      rotate_port: true,
      max_ports: 20,
    },
    serverUrl: 'http://localhost:7777/',
  });
  expect(startTmuxCheckMock).toHaveBeenCalledTimes(1);

  await output.event?.({
    event: {
      type: 'session.created',
      properties: { info: { id: 's-1', parentID: 'parent', title: 'Task' } },
    },
  });

  expect(onSessionCreatedMock).toHaveBeenCalledWith({
    type: 'session.created',
    properties: { info: { id: 's-1', parentID: 'parent', title: 'Task' } },
  });
});

test('plugin duplicate init skips manager creation and tmux check', async () => {
  loadConfigMock.mockReturnValueOnce({
    enabled: false,
    layout: 'tiled',
    main_pane_size: 60,
    auto_close: true,
    spawn_delay_ms: 0,
    max_retry_attempts: 0,
    layout_debounce_ms: 0,
    max_agents_per_column: 1,
    reaper_enabled: false,
    reaper_interval_ms: 0,
    reaper_min_zombie_checks: 0,
    reaper_grace_period_ms: 0,
    reaper_auto_self_destruct: false,
    reaper_self_destruct_timeout_ms: 0,
    rotate_port: false,
    max_ports: 1,
  });

  const { default: plugin, resetOpencodeAgentTmuxStateForTest } = await importPlugin();
  resetOpencodeAgentTmuxStateForTest();
  const ctx = createPluginInput('/work', 'http://localhost:9999');

  const first = await plugin(ctx);
  const second = await plugin(ctx);

  expect(typeof first.config).toBe('function');
  expect(typeof first.event).toBe('function');
  expect(typeof first.dispose).toBe('function');
  expect(typeof second.config).toBe('function');
  expect(typeof second.event).toBe('function');
  expect(typeof second.dispose).toBe('function');
  expect(constructorCalls).toHaveLength(1);
  expect(startTmuxCheckMock).not.toHaveBeenCalled();
  expect(logMock).toHaveBeenCalledWith('[plugin] duplicate initialization detected, skipping', {
    directory: '/work',
  });
  await second.event?.({
    event: { type: 'session.created', properties: { info: { id: 'dup', parentID: 'parent' } } },
  });
  expect(onSessionCreatedMock).not.toHaveBeenCalled();
});

test('plugin derives serverUrl from OPENCODE_PORT when ctx.serverUrl is missing', async () => {
  loadConfigMock.mockReturnValueOnce({
    enabled: true,
    layout: 'main-vertical',
    main_pane_size: 60,
    auto_close: true,
    spawn_delay_ms: 0,
    max_retry_attempts: 2,
    layout_debounce_ms: 150,
    max_agents_per_column: 3,
    reaper_enabled: false,
    reaper_interval_ms: 30000,
    reaper_min_zombie_checks: 3,
    reaper_grace_period_ms: 5000,
    reaper_auto_self_destruct: true,
    reaper_self_destruct_timeout_ms: 600000,
    rotate_port: false,
    max_ports: 10,
  });

  const originalPort = process.env.OPENCODE_PORT;
  delete process.env.OPENCODE_PORT;

  try {
    const { default: plugin, resetOpencodeAgentTmuxStateForTest } = await importPlugin();
    resetOpencodeAgentTmuxStateForTest();
    const output = await plugin(createPluginInput('/work'));

  expect(typeof output.config).toBe('function');
  expect(typeof output.event).toBe('function');
  expect(typeof output.dispose).toBe('function');
    expect(startTmuxCheckMock).toHaveBeenCalledTimes(1);
    expect(constructorCalls[0].serverUrl).toBe('http://localhost:4096');
  } finally {
    if (originalPort) {
      process.env.OPENCODE_PORT = originalPort;
    } else {
      delete process.env.OPENCODE_PORT;
    }
  }
});
