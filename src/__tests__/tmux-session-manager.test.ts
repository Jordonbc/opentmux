import { test, expect, mock, beforeEach, spyOn, afterEach } from 'bun:test';
import { TmuxSessionManager } from '../tmux-session-manager';
import type { PluginInput } from '../types';
import type { TmuxConfig } from '../config';
import * as utils from '../utils';
import * as tmuxUtils from '../utils/tmux';
import { setSpawnAsyncFn, resetSpawnAsyncFn, resetTmuxPathCache } from '../utils/tmux';

// Helper to create controlled promises for test synchronization
function createControlledPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Helper to wait for a condition with timeout
async function waitFor(
  conditionFn: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (!conditionFn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Track spawn calls
let spawnCalls: Array<{ sessionId: string; title: string }> = [];
let spawnControllers: Map<string, { resolve: (result: { success: boolean; paneId?: string }) => void }> = new Map();
let layoutCallCount = 0;

function createMockPluginInput(): PluginInput {
  return {
    directory: '/test',
    serverUrl: 'http://localhost:4096',
    client: {
      session: {
        status: mock(async () => ({ data: {} })),
        subscribe: mock(() => () => {}),
      },
    },
  };
}

function createTmuxConfig(overrides?: Partial<TmuxConfig>): TmuxConfig {
  return {
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
    ...overrides,
  };
}

beforeEach(() => {
  spawnCalls = [];
  spawnControllers.clear();
  layoutCallCount = 0;
  resetTmuxPathCache();

  setSpawnAsyncFn(async (command: string[]) => {
    if (command.includes('display-message')) {
      return { exitCode: 0, stdout: '%77\n', stderr: '' };
    }

    if (command.includes('-V')) {
      return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
    }

    return { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' };
  });

  // Setup spies on utils
  spyOn(utils, 'log').mockImplementation(() => {});
  
  spyOn(utils, 'isInsideTmux').mockReturnValue(true);
  
  spyOn(utils, 'closeTmuxPane').mockResolvedValue(true);
  
  spyOn(utils, 'applyTmuxLayout').mockImplementation(async () => {
    layoutCallCount++;
  });
  
  spyOn(utils, 'spawnTmuxPane').mockImplementation(async (sessionId: string, title: string) => {
    spawnCalls.push({ sessionId, title });
    const ctrl = createControlledPromise<{ success: boolean; paneId?: string }>();
    spawnControllers.set(sessionId, { resolve: ctrl.resolve });
    return ctrl.promise;
  });
});

afterEach(() => {
  resetSpawnAsyncFn();
  mock.restore();
});

test('TmuxSessionManager queues spawns sequentially', async () => {
  const ctx = createMockPluginInput();
  const config = createTmuxConfig();
  const manager = new TmuxSessionManager(ctx, config, 'http://localhost:4096');

  const event1 = {
    type: 'session.created',
    properties: { info: { id: 'session-1', parentID: 'parent-1', title: 'Task 1' } },
  };
  const event2 = {
    type: 'session.created',
    properties: { info: { id: 'session-2', parentID: 'parent-1', title: 'Task 2' } },
  };

  const promise1 = manager.onSessionCreated(event1);
  const promise2 = manager.onSessionCreated(event2);

  await waitFor(() => spawnCalls.length >= 1);

  expect(spawnCalls.length).toBe(1);
  expect(spawnCalls[0].sessionId).toBe('session-1');
  expect(spawnCalls.find(c => c.sessionId === 'session-2')).toBeUndefined();

  spawnControllers.get('session-1')?.resolve({ success: true, paneId: '%1' });

  await waitFor(() => spawnCalls.length >= 2);

  expect(spawnCalls.length).toBe(2);
  expect(spawnCalls[1].sessionId).toBe('session-2');

  spawnControllers.get('session-2')?.resolve({ success: true, paneId: '%2' });

  await Promise.all([promise1, promise2]);
});

test('TmuxSessionManager tracks sessions after successful spawn', async () => {
  const ctx = createMockPluginInput();
  const config = createTmuxConfig();
  const manager = new TmuxSessionManager(ctx, config, 'http://localhost:4096');

  const event = {
    type: 'session.created',
    properties: { info: { id: 'track-test', parentID: 'parent', title: 'Tracked' } },
  };

  const promise = manager.onSessionCreated(event);

  await waitFor(() => spawnControllers.has('track-test'));
  spawnControllers.get('track-test')?.resolve({ success: true, paneId: '%42' });

  await promise;

  const duplicatePromise = manager.onSessionCreated(event);
  await duplicatePromise;

  expect(spawnCalls.filter(c => c.sessionId === 'track-test').length).toBe(1);
});

test('TmuxSessionManager accepts sessionID with parentId alias', async () => {
  const ctx = createMockPluginInput();
  const config = createTmuxConfig();
  const manager = new TmuxSessionManager(ctx, config, 'http://localhost:4096');

  const event = {
    type: 'session.created',
    properties: {
      sessionID: 'alias-test',
      info: { parentId: 'parent', title: 'Alias Parent' },
    },
  };

  const promise = manager.onSessionCreated(event);

  await waitFor(() => spawnControllers.has('alias-test'));
  spawnControllers.get('alias-test')?.resolve({ success: true, paneId: '%43' });

  await promise;

  expect(spawnCalls.length).toBe(1);
  expect(spawnCalls[0]).toEqual({ sessionId: 'alias-test', title: 'Alias Parent' });
});

test('TmuxSessionManager accepts session payload container', async () => {
  const ctx = createMockPluginInput();
  const config = createTmuxConfig();
  const manager = new TmuxSessionManager(ctx, config, 'http://localhost:4096');

  const event = {
    type: 'session.created',
    properties: {
      session: { id: 'session-container-test', parentID: 'parent', title: 'Session Payload' },
    },
  };

  const promise = manager.onSessionCreated(event);

  await waitFor(() => spawnControllers.has('session-container-test'));
  spawnControllers.get('session-container-test')?.resolve({ success: true, paneId: '%44' });

  await promise;

  expect(spawnCalls.length).toBe(1);
  expect(spawnCalls[0]).toEqual({ sessionId: 'session-container-test', title: 'Session Payload' });
});

test('TmuxSessionManager ignores root session without parent id', async () => {
  const ctx = createMockPluginInput();
  const config = createTmuxConfig();
  const manager = new TmuxSessionManager(ctx, config, 'http://localhost:4096');

  const event = {
    type: 'session.created',
    properties: { sessionID: 'root-session', info: { id: 'root-session', title: 'Root' } },
  };

  await manager.onSessionCreated(event);

  expect(spawnCalls.length).toBe(0);
});

test('TmuxSessionManager does not track session on spawn failure', async () => {
  const ctx = createMockPluginInput();
  const config = createTmuxConfig({ max_retry_attempts: 0 });
  const manager = new TmuxSessionManager(ctx, config, 'http://localhost:4096');

  const event = {
    type: 'session.created',
    properties: { info: { id: 'fail-test', parentID: 'parent', title: 'Fail' } },
  };

  const promise = manager.onSessionCreated(event);

  await waitFor(() => spawnControllers.has('fail-test'));
  spawnControllers.get('fail-test')?.resolve({ success: false });

  await promise;

  expect(spawnCalls.length).toBe(1);
  expect(spawnCalls[0].sessionId).toBe('fail-test');
});

test('TmuxSessionManager ignores non-session.created events', async () => {
  const ctx = createMockPluginInput();
  const config = createTmuxConfig();
  const manager = new TmuxSessionManager(ctx, config, 'http://localhost:4096');

  const event = {
    type: 'session.updated',
    properties: { info: { id: 'ignored', parentID: 'parent', title: 'Ignored' } },
  };

  await manager.onSessionCreated(event);

  expect(spawnCalls.length).toBe(0);
});

test('TmuxSessionManager ignores events without session info', async () => {
  const ctx = createMockPluginInput();
  const config = createTmuxConfig();
  const manager = new TmuxSessionManager(ctx, config, 'http://localhost:4096');

  const event1 = {
    type: 'session.created',
    properties: {},
  };

  const event2 = {
    type: 'session.created',
    properties: { info: { parentID: 'parent' } },
  };

  await manager.onSessionCreated(event1);
  await manager.onSessionCreated(event2);

  expect(spawnCalls.length).toBe(0);
});

test('TmuxSessionManager createEventHandler wraps onSessionCreated', async () => {
  const ctx = createMockPluginInput();
  const config = createTmuxConfig();
  const manager = new TmuxSessionManager(ctx, config, 'http://localhost:4096');

  const handler = manager.createEventHandler();

  const event = {
    type: 'session.created',
    properties: { info: { id: 'handler-test', parentID: 'parent', title: 'Handler' } },
  };

  const promise = handler({ event });

  await waitFor(() => spawnControllers.has('handler-test'));
  spawnControllers.get('handler-test')?.resolve({ success: true, paneId: '%1' });

  await promise;

  expect(spawnCalls.length).toBe(1);
  expect(spawnCalls[0].sessionId).toBe('handler-test');
});

test('TmuxSessionManager uses config spawn_delay_ms and max_retry_attempts', async () => {
  const ctx = createMockPluginInput();
  const config = createTmuxConfig({
    spawn_delay_ms: 100,
    max_retry_attempts: 3,
  });
  
  const manager = new TmuxSessionManager(ctx, config, 'http://localhost:4096');

  const event = {
    type: 'session.created',
    properties: { info: { id: 'config-test', parentID: 'parent', title: 'Config' } },
  };

  const promise = manager.onSessionCreated(event);

  await waitFor(() => spawnControllers.has('config-test'));
  spawnControllers.get('config-test')?.resolve({ success: true, paneId: '%1' });

  await promise;

  expect(spawnCalls.length).toBe(1);
});

test('TmuxSessionManager reuses the first resolved target pane for queued spawns', async () => {
  const ctx = createMockPluginInput();
  const config = createTmuxConfig();
  const spawnTargets: Array<string | null | undefined> = [];

  const getCurrentPaneIdSpy = spyOn(tmuxUtils, 'getCurrentPaneId')
    .mockResolvedValueOnce('%root-pane')
    .mockResolvedValueOnce('%wrong-pane');

  const spawnSpy = spyOn(utils, 'spawnTmuxPane').mockImplementation(async (
    _sessionId: string,
    _title: string,
    _config: TmuxConfig,
    _serverUrl: string,
    targetPaneId?: string | null,
  ) => {
    spawnTargets.push(targetPaneId);
    return {
      success: true,
      paneId: `%${spawnTargets.length}`,
    };
  });

  const manager = new TmuxSessionManager(ctx, config, 'http://localhost:4096');

  const firstEvent = {
    type: 'session.created',
    properties: { info: { id: 'target-test-1', parentID: 'parent', title: 'Target 1' } },
  };

  const secondEvent = {
    type: 'session.created',
    properties: { info: { id: 'target-test-2', parentID: 'parent', title: 'Target 2' } },
  };

  await manager.onSessionCreated(firstEvent);
  await manager.onSessionCreated(secondEvent);

  expect(getCurrentPaneIdSpy).toHaveBeenCalledTimes(1);
  expect(spawnSpy).toHaveBeenCalledTimes(2);
  expect(spawnTargets).toEqual(['%root-pane', '%root-pane']);
});

test('TmuxSessionManager respects auto_close=false', async () => {
  const ctx = createMockPluginInput();
  const config = createTmuxConfig({ auto_close: false });
  const manager = new TmuxSessionManager(ctx, config, 'http://localhost:4096');

  const event = {
    type: 'session.created',
    properties: { info: { id: 'noclose-test', parentID: 'parent', title: 'No Close' } },
  };

  const promise = manager.onSessionCreated(event);

  await waitFor(() => spawnControllers.has('noclose-test'));
  spawnControllers.get('noclose-test')?.resolve({ success: true, paneId: '%9' });
  await promise;

  await new Promise((r) => setTimeout(r, 2100));

  expect(utils.closeTmuxPane).not.toHaveBeenCalled();
});

test('TmuxSessionManager forgets missing sessions after timeout when auto_close=false', async () => {
  const ctx = createMockPluginInput();
  const config = createTmuxConfig({ auto_close: false });
  const statusMock = mock(async () => ({ data: {} }));
  ctx.client.session.status = statusMock as typeof ctx.client.session.status;

  let now = 1_000_000;
  spyOn(Date, 'now').mockImplementation(() => now);

  const manager = new TmuxSessionManager(ctx, config, 'http://localhost:4096');
  const event = {
    type: 'session.created',
    properties: { info: { id: 'forget-test', parentID: 'parent', title: 'Forget' } },
  };

  const promise = manager.onSessionCreated(event);
  await waitFor(() => spawnControllers.has('forget-test'));
  spawnControllers.get('forget-test')?.resolve({ success: true, paneId: '%10' });
  await promise;

  await (manager as unknown as { pollSessions: () => Promise<void> }).pollSessions();
  now += 10 * 60 * 1000 + 1;
  await (manager as unknown as { pollSessions: () => Promise<void> }).pollSessions();

  expect(utils.closeTmuxPane).not.toHaveBeenCalled();

  const secondPromise = manager.onSessionCreated(event);
  await waitFor(() => spawnCalls.length === 2);
  spawnControllers.get('forget-test')?.resolve({ success: true, paneId: '%11' });
  await secondPromise;

  await manager.cleanup();
});

test('TmuxSessionManager does not close panes when session status is briefly missing', async () => {
  const ctx = createMockPluginInput();
  const config = createTmuxConfig();
  const statusMock = mock()
    .mockResolvedValueOnce({ data: {} })
    .mockResolvedValueOnce({ data: { 'missing-test': { type: 'running' } } });

  ctx.client.session.status = statusMock as typeof ctx.client.session.status;

  spyOn(utils, 'spawnTmuxPane').mockResolvedValue({ success: true, paneId: '%123' });

  const manager = new TmuxSessionManager(ctx, config, 'http://localhost:4096');

  const event = {
    type: 'session.created',
    properties: { info: { id: 'missing-test', parentID: 'parent', title: 'Missing' } },
  };

  await manager.onSessionCreated(event);

  await (manager as unknown as { pollSessions: () => Promise<void> }).pollSessions();
  await (manager as unknown as { pollSessions: () => Promise<void> }).pollSessions();

  expect(utils.closeTmuxPane).not.toHaveBeenCalled();

  await manager.cleanup();
});

test('TmuxSessionManager applies layout once after queue drains (deferred layout)', async () => {
  const ctx = createMockPluginInput();
  const config = createTmuxConfig({
    layout_debounce_ms: 50,
    spawn_delay_ms: 0,
  });
  const manager = new TmuxSessionManager(ctx, config, 'http://localhost:4096');

  const events = [
    { type: 'session.created', properties: { info: { id: 'batch-1', parentID: 'parent', title: 'Batch 1' } } },
    { type: 'session.created', properties: { info: { id: 'batch-2', parentID: 'parent', title: 'Batch 2' } } },
    { type: 'session.created', properties: { info: { id: 'batch-3', parentID: 'parent', title: 'Batch 3' } } },
  ];

  const promises = events.map((e) => manager.onSessionCreated(e));

  await waitFor(() => spawnControllers.has('batch-1'));
  expect(layoutCallCount).toBe(0);
  spawnControllers.get('batch-1')?.resolve({ success: true, paneId: '%1' });

  await waitFor(() => spawnControllers.has('batch-2'));
  spawnControllers.get('batch-2')?.resolve({ success: true, paneId: '%2' });

  await waitFor(() => spawnControllers.has('batch-3'));
  spawnControllers.get('batch-3')?.resolve({ success: true, paneId: '%3' });

  await Promise.all(promises);

  expect(spawnCalls.length).toBe(3);
  
  // Wait for debounce
  await new Promise((r) => setTimeout(r, 100));

  expect(layoutCallCount).toBeGreaterThan(0);
});
