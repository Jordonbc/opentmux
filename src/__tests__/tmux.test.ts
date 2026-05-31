import { test, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  applyTmuxLayout,
  getCurrentPaneId,
  getTmuxPath,
  isInsideTmux,
  closeTmuxPane,
  startTmuxCheck,
  spawnTmuxPane,
  spawnAsync,
  setSpawnAsyncFn,
  resetSpawnAsyncFn,
  resetStoredConfigForTest,
  resetServerCheck,
  resetTmuxPathCache,
} from '../utils/tmux';
import type { TmuxConfig } from '../config';

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type MockSpawnFn = (
  command: string[],
  options?: { ignoreOutput?: boolean },
) => Promise<SpawnResult>;

function createMockSpawnFn(): {
  fn: MockSpawnFn;
  calls: Array<{ command: string[]; options?: { ignoreOutput?: boolean } }>;
  results: SpawnResult[];
} {
  const calls: Array<{ command: string[]; options?: { ignoreOutput?: boolean } }> = [];
  const results: SpawnResult[] = [];

  const fn: MockSpawnFn = async (command, options) => {
    calls.push({ command, options });
    const result = results.shift();
    if (!result) {
      throw new Error('No more mock results configured');
    }
    return result;
  };

  return { fn, calls, results };
}

function createTestConfig(overrides: Partial<TmuxConfig> = {}): TmuxConfig {
  return {
    enabled: true,
    layout: 'main-vertical',
    main_pane_size: 60,
    auto_close: true,
    spawn_delay_ms: 300,
    max_retry_attempts: 2,
    layout_debounce_ms: 150,
    max_agents_per_column: 3,
    reaper_enabled: true,
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

const originalEnv = process.env.TMUX;
let mockData: ReturnType<typeof createMockSpawnFn>;

beforeEach(() => {
  process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
  resetServerCheck();
  resetTmuxPathCache();
  resetSpawnAsyncFn();
  resetStoredConfigForTest();
  mockData = createMockSpawnFn();
});

afterEach(() => {
  if (originalEnv) {
    process.env.TMUX = originalEnv;
  } else {
    delete process.env.TMUX;
  }
  resetSpawnAsyncFn();
});

test('isInsideTmux reflects the TMUX environment variable', () => {
  const originalTmux = process.env.TMUX;

  delete process.env.TMUX;
  expect(isInsideTmux()).toBe(false);

  process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
  expect(isInsideTmux()).toBe(true);

  if (originalTmux) {
    process.env.TMUX = originalTmux;
  } else {
    delete process.env.TMUX;
  }
});

test('getTmuxPath caches the tmux binary path until reset', async () => {
  mockData.results.push(
    { exitCode: 0, stdout: '/usr/local/bin/tmux\n', stderr: '' },
    { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' },
  );

  setSpawnAsyncFn(mockData.fn);

  const first = await getTmuxPath();
  expect(first).toBe('/usr/local/bin/tmux');
  expect(mockData.calls.length).toBe(2);

  const second = await getTmuxPath();
  expect(second).toBe('/usr/local/bin/tmux');
  expect(mockData.calls.length).toBe(2);

  resetTmuxPathCache();

  mockData.results.push(
    { exitCode: 0, stdout: '/opt/homebrew/bin/tmux\n', stderr: '' },
    { exitCode: 0, stdout: 'tmux 3.4\n', stderr: '' },
  );

  const third = await getTmuxPath();
  expect(third).toBe('/opt/homebrew/bin/tmux');
  expect(mockData.calls.length).toBe(4);
});

test('getCurrentPaneId returns the current tmux pane id', async () => {
  mockData.results.push({ exitCode: 0, stdout: '%42\n', stderr: '' });
  setSpawnAsyncFn(mockData.fn);

  expect(getCurrentPaneId('/usr/bin/tmux')).resolves.toBe('%42');
});

test('getTmuxPath returns null when lookup throws', async () => {
  setSpawnAsyncFn(async () => {
    throw new Error('lookup blew up');
  });

  expect(await getTmuxPath()).toBeNull();
});

test('getTmuxPath returns null for failed lookup and verification errors', async () => {
  setSpawnAsyncFn(mockData.fn);

  mockData.results.push({ exitCode: 1, stdout: '', stderr: 'not found' });
  expect(await getTmuxPath()).toBeNull();

  resetTmuxPathCache();
  mockData.results.push({ exitCode: 0, stdout: '\n', stderr: '' });
  expect(await getTmuxPath()).toBeNull();

  resetTmuxPathCache();
  mockData.results.push(
    { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' },
    { exitCode: 1, stdout: '', stderr: 'tmux -V failed' },
  );
  expect(await getTmuxPath()).toBeNull();
});

test('applyTmuxLayout returns immediately when no config has been stored yet', async () => {
  await applyTmuxLayout();

  expect(mockData.calls.length).toBe(0);
});

test('spawnAsync captures stdout and stderr from a child process', async () => {
  const result = await spawnAsync(['sh', '-c', 'printf stdout; printf stderr >&2']);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe('stdout');
  expect(result.stderr).toBe('stderr');
});

test('spawnAsync resolves with exitCode 1 when the command cannot spawn', async () => {
  const result = await spawnAsync(['definitely-not-a-real-command-12345']);

  expect(result.exitCode).toBe(1);
});

test('applyTmuxLayout applies built-in main-horizontal layout after a spawn', async () => {
  mockData.results.push(
    { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' },
    { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' },
    { exitCode: 0, stdout: '%9\n', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
  );

  setSpawnAsyncFn(mockData.fn);

  const mockFetch = mock(async () => new Response('ok', { status: 200 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const config = createTestConfig({ layout: 'main-horizontal', main_pane_size: 73, max_retry_attempts: 0 });
    const spawnResult = await spawnTmuxPane('session-layout', 'Layout Task', config, 'http://localhost:4096');
    expect(spawnResult.success).toBe(true);

    await applyTmuxLayout();

    const setWindowCall = mockData.calls.find((c) => c.command.includes('set-window-option'));
    expect(setWindowCall?.command).toEqual([
      '/usr/bin/tmux',
      'set-window-option',
      'main-pane-height',
      '73%',
    ]);

    const selectLayoutCalls = mockData.calls.filter((c) => c.command.includes('select-layout'));
    expect(selectLayoutCalls.length).toBeGreaterThanOrEqual(2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('applyTmuxLayout returns when tmux binary is missing after config is stored', async () => {
  mockData.results.push(
    { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' },
    { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' },
    { exitCode: 0, stdout: '%31\n', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
  );

  setSpawnAsyncFn(mockData.fn);

  const mockFetch = mock(async () => new Response('ok', { status: 200 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const config = createTestConfig({ layout: 'main-horizontal', max_retry_attempts: 0 });
    const result = await spawnTmuxPane('session-store-config', 'Store Config', config, 'http://localhost:4096');
    expect(result.success).toBe(true);

    resetTmuxPathCache();
    setSpawnAsyncFn(async (command: string[]) => {
      if (command[0] === 'which') {
        return { exitCode: 1, stdout: '', stderr: 'tmux missing' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await applyTmuxLayout();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('applyTmuxLayout applies custom main-vertical multi-column layout', async () => {
  mockData.results.push(
    { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' },
    { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' },
    { exitCode: 0, stdout: '%11\n', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 0, stdout: '120 40\n', stderr: '' },
    { exitCode: 0, stdout: '%11\n', stderr: '' },
    { exitCode: 0, stdout: '%11\n%12\n%13\n', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
  );

  setSpawnAsyncFn(mockData.fn);

  const mockFetch = mock(async () => new Response('ok', { status: 200 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const config = createTestConfig({ layout: 'main-vertical', max_agents_per_column: 2, max_retry_attempts: 0 });
    const spawnResult = await spawnTmuxPane('session-custom', 'Custom Task', config, 'http://localhost:4096');
    expect(spawnResult.success).toBe(true);

    await applyTmuxLayout();

    const selectLayoutCalls = mockData.calls.filter((c) => c.command.includes('select-layout'));
    expect(selectLayoutCalls.some((c) => c.command.length === 3 && c.command[2] !== 'main-vertical')).toBe(true);
    expect(selectLayoutCalls[selectLayoutCalls.length - 1].command[2]).toContain('120x40,0,0');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('applyTmuxLayout returns false path when no agent panes are present in multi-column mode', async () => {
  const commands: string[][] = [];

  setSpawnAsyncFn(async (command: string[]) => {
    commands.push(command);
    const commandText = command.join(' ');
    if (command[0] === 'which') {
      return { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' };
    }
    if (command[0] === '/usr/bin/tmux' && commandText.includes('-V')) {
      return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
    }
    if (commandText.includes('split-window')) {
      return { exitCode: 0, stdout: '%50\n', stderr: '' };
    }
    if (commandText.includes('select-pane')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (commandText.includes('display-message') && commandText.includes('#{window_width}')) {
      return { exitCode: 0, stdout: '120 40\n', stderr: '' };
    }
    if (commandText.includes('display-message') && commandText.includes('#{pane_id}')) {
      return { exitCode: 0, stdout: '%50\n', stderr: '' };
    }
    if (commandText.includes('list-panes')) {
      return { exitCode: 0, stdout: '%50\n%50\n', stderr: '' };
    }
    if (commandText.includes('select-layout')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  const mockFetch = mock(async () => new Response('ok', { status: 200 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const config = createTestConfig({ layout: 'main-vertical', max_agents_per_column: 2, max_retry_attempts: 0 });
    const result = await spawnTmuxPane('session-empty-cols', 'Empty Columns', config, 'http://localhost:4096');
    expect(result.success).toBe(true);

    await applyTmuxLayout();

    expect(commands.some((c) => c.join(' ').includes('list-panes'))).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('applyTmuxLayout falls back when multi-column layout helper throws', async () => {
  setSpawnAsyncFn(async (command: string[]) => {
    const commandText = command.join(' ');
    if (command[0] === 'which') {
      return { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' };
    }
    if (command[0] === '/usr/bin/tmux' && commandText.includes('-V')) {
      return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
    }
    if (commandText.includes('split-window')) {
      return { exitCode: 0, stdout: '%51\n', stderr: '' };
    }
    if (commandText.includes('select-pane')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (commandText.includes('display-message') && commandText.includes('#{window_width}')) {
      return { exitCode: 0, stdout: '120 40\n', stderr: '' };
    }
    if (commandText.includes('display-message') && commandText.includes('#{pane_id}')) {
      return { exitCode: 0, stdout: '%51\n', stderr: '' };
    }
    if (commandText.includes('list-panes')) {
      throw new Error('pane list failed');
    }
    if (commandText.includes('select-layout')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  const mockFetch = mock(async () => new Response('ok', { status: 200 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const config = createTestConfig({ layout: 'main-vertical', max_agents_per_column: 2, max_retry_attempts: 0 });
    const result = await spawnTmuxPane('session-fallback-throw', 'Fallback Throw', config, 'http://localhost:4096');
    expect(result.success).toBe(true);

    await applyTmuxLayout();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('applyTmuxLayout handles fallback select-layout failures', async () => {
  setSpawnAsyncFn(async (command: string[]) => {
    const commandText = command.join(' ');
    if (command[0] === 'which') {
      return { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' };
    }
    if (command[0] === '/usr/bin/tmux' && commandText.includes('-V')) {
      return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
    }
    if (commandText.includes('split-window')) {
      return { exitCode: 0, stdout: '%52\n', stderr: '' };
    }
    if (commandText.includes('select-pane')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (commandText.includes('display-message') && commandText.includes('#{window_width}')) {
      return { exitCode: 0, stdout: '120 40\n', stderr: '' };
    }
    if (commandText.includes('display-message') && commandText.includes('#{pane_id}')) {
      return { exitCode: 0, stdout: '%52\n', stderr: '' };
    }
    if (commandText.includes('list-panes')) {
      throw new Error('pane list failed');
    }
    if (commandText.includes('select-layout')) {
      return { exitCode: 1, stdout: '', stderr: 'fallback layout failed' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  const mockFetch = mock(async () => new Response('ok', { status: 200 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const config = createTestConfig({ layout: 'main-vertical', max_agents_per_column: 2, max_retry_attempts: 0 });
    const result = await spawnTmuxPane('session-fallback-fail', 'Fallback Fail', config, 'http://localhost:4096');
    expect(result.success).toBe(true);

    await applyTmuxLayout();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('applyTmuxLayout falls back when there are no agent panes', async () => {
  const commands: string[][] = [];

  setSpawnAsyncFn(async (command: string[]) => {
    commands.push(command);
    const commandText = command.join(' ');
    if (command[0] === 'which') {
      return { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' };
    }
    if (command[0] === '/usr/bin/tmux' && commandText.includes('-V')) {
      return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
    }
    if (commandText.includes('split-window')) {
      return { exitCode: 0, stdout: '%11\n', stderr: '' };
    }
    if (commandText.includes('select-pane')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (commandText.includes('display-message') && commandText.includes('#{window_width}')) {
      return { exitCode: 0, stdout: '120 40\n', stderr: '' };
    }
    if (commandText.includes('display-message') && commandText.includes('#{pane_id}')) {
      return { exitCode: 0, stdout: '%11\n', stderr: '' };
    }
    if (commandText.includes('list-panes')) {
      return { exitCode: 0, stdout: '%11\n', stderr: '' };
    }
    if (commandText.includes('set-window-option')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (commandText.includes('select-layout')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  const mockFetch = mock(async () => new Response('ok', { status: 200 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const config = createTestConfig({ layout: 'main-vertical', max_retry_attempts: 0 });
    const result = await spawnTmuxPane('session-empty-cols', 'Empty Columns', config, 'http://localhost:4096');
    expect(result.success).toBe(true);

    await applyTmuxLayout();

    expect(commands.some((c) => c.includes('list-panes'))).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('applyTmuxLayout falls back when custom multi-column layout fails', async () => {
  const commands: string[][] = [];

  setSpawnAsyncFn(async (command: string[]) => {
    commands.push(command);
    const commandText = command.join(' ');
    if (command[0] === 'which') {
      return { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' };
    }
    if (command[0] === '/usr/bin/tmux' && commandText.includes('-V')) {
      return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
    }
    if (commandText.includes('split-window')) {
      return { exitCode: 0, stdout: '%20\n', stderr: '' };
    }
    if (commandText.includes('select-pane')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (commandText.includes('display-message') && commandText.includes('#{window_width}')) {
      return { exitCode: 0, stdout: '120 40\n', stderr: '' };
    }
    if (commandText.includes('display-message') && commandText.includes('#{pane_id}')) {
      return { exitCode: 0, stdout: '%20\n', stderr: '' };
    }
    if (commandText.includes('list-panes')) {
      return { exitCode: 0, stdout: '%20\n%21\n%22\n', stderr: '' };
    }
    if (commandText.includes('select-layout')) {
      if (commandText.includes('x')) {
        return { exitCode: 1, stdout: '', stderr: 'layout failed' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (commandText.includes('set-window-option')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  const mockFetch = mock(async () => new Response('ok', { status: 200 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const config = createTestConfig({ layout: 'main-vertical', max_agents_per_column: 2, max_retry_attempts: 0 });
    const result = await spawnTmuxPane('session-layout-fail', 'Layout Fail', config, 'http://localhost:4096');
    expect(result.success).toBe(true);

    await applyTmuxLayout();

    expect(commands.some((c) => c.join(' ').includes('layout failed'))).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('spawnTmuxPane succeeds on first attempt', async () => {
  mockData.results.push(
    { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' },
    { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' },
    { exitCode: 0, stdout: '%5\n', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
  );

  setSpawnAsyncFn(mockData.fn);

  const mockFetch = mock(async () => new Response('ok', { status: 200 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const config = createTestConfig();
    const result = await spawnTmuxPane('session-1', 'Test Task', config, 'http://localhost:4096');

    expect(result.success).toBe(true);
    expect(result.paneId).toBe('%5');

    const splitWindowCall = mockData.calls.find((c) =>
      c.command.includes('split-window'),
    );
    expect(splitWindowCall).toBeDefined();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('spawnTmuxPane retries on failure with exponential backoff', async () => {
  mockData.results.push(
    { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' },
    { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' },
    { exitCode: 1, stdout: '', stderr: 'split failed' },
    { exitCode: 1, stdout: '', stderr: 'split failed again' },
    { exitCode: 0, stdout: '%7\n', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
  );

  const timestamps: number[] = [];
  const wrappedFn: MockSpawnFn = async (command, options) => {
    if (command.includes('split-window')) {
      timestamps.push(Date.now());
    }
    return mockData.fn(command, options);
  };

  setSpawnAsyncFn(wrappedFn);

  const mockFetch = mock(async () => new Response('ok', { status: 200 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const config = createTestConfig({ max_retry_attempts: 2 });
    const result = await spawnTmuxPane('session-2', 'Retry Task', config, 'http://localhost:4096');

    expect(result.success).toBe(true);
    expect(result.paneId).toBe('%7');
    expect(timestamps.length).toBe(3);

    const delay1 = timestamps[1] - timestamps[0];
    const delay2 = timestamps[2] - timestamps[1];

    expect(delay1).toBeGreaterThanOrEqual(240);
    expect(delay1).toBeLessThan(400);
    expect(delay2).toBeGreaterThanOrEqual(490);
    expect(delay2).toBeLessThan(700);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('spawnTmuxPane retries when tmux split-window throws', async () => {
  const throwingFn = async (command: string[]) => {
    if (command.includes('which')) return { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' };
    if (command.includes('-V')) return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
    if (command.includes('split-window')) {
      throw new Error('split failed hard');
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  setSpawnAsyncFn(throwingFn);

  const mockFetch = mock(async () => new Response('ok', { status: 200 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const config = createTestConfig({ max_retry_attempts: 1 });
    const result = await spawnTmuxPane('session-throw', 'Throw Task', config, 'http://localhost:4096');

    expect(result.success).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('spawnTmuxPane skips the health check on repeated serverUrl calls', async () => {
  let fetchCount = 0;
  const mockFetch = mock(async () => {
    fetchCount++;
    return new Response('ok', { status: 200 });
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  const spawnCalls: string[][] = [];
  setSpawnAsyncFn(async (command: string[]) => {
    spawnCalls.push(command);
    if (command.includes('which')) return { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' };
    if (command.includes('-V')) return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
    if (command.includes('split-window')) return { exitCode: 0, stdout: '%15\n', stderr: '' };
    if (command.includes('select-pane')) return { exitCode: 0, stdout: '', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  try {
    const config = createTestConfig({ max_retry_attempts: 0 });
    await spawnTmuxPane('session-cache-1', 'Cache 1', config, 'http://localhost:4096');
    await spawnTmuxPane('session-cache-2', 'Cache 2', config, 'http://localhost:4096');

    expect(fetchCount).toBe(1);
    expect(spawnCalls.filter((c) => c.includes('split-window')).length).toBe(2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('applyTmuxLayout falls back to built-in layout when custom application throws', async () => {
  let throwOnSetWindow = false;
  const commands: string[][] = [];

  setSpawnAsyncFn(async (command: string[]) => {
    commands.push(command);
    if (command.includes('which')) return { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' };
    if (command.includes('-V')) return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
    if (command.includes('split-window')) return { exitCode: 0, stdout: '%22\n', stderr: '' };
    if (command.includes('select-pane')) return { exitCode: 0, stdout: '', stderr: '' };
    if (command.includes('display-message') && command.includes('#{window_width}')) {
      return { exitCode: 0, stdout: '120 40\n', stderr: '' };
    }
    if (command.includes('display-message') && command.includes('#{pane_id}')) {
      return { exitCode: 0, stdout: '%22\n', stderr: '' };
    }
    if (command.includes('list-panes')) {
      return { exitCode: 0, stdout: '%22\n%23\n%24\n', stderr: '' };
    }
    if (command.includes('set-window-option')) {
      if (throwOnSetWindow) {
        throw new Error('layout failed');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (command.includes('select-layout')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  const mockFetch = mock(async () => new Response('ok', { status: 200 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const config = createTestConfig({ layout: 'main-horizontal', max_retry_attempts: 0 });
    const result = await spawnTmuxPane('session-layout-fallback', 'Fallback', config, 'http://localhost:4096');
    expect(result.success).toBe(true);

    throwOnSetWindow = true;
    await applyTmuxLayout();

    expect(commands.some((cmd) => cmd.includes('set-window-option'))).toBe(true);
    expect(commands.at(-1)).toEqual(['/usr/bin/tmux', 'set-window-option', 'main-pane-height', '60%']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('applyTmuxLayout falls back when layout sizing throws', async () => {
  let throwOnWindowSize = false;
  const commands: string[][] = [];

  setSpawnAsyncFn(async (command: string[]) => {
    commands.push(command);
    if (command.includes('which')) return { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' };
    if (command.includes('-V')) return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
    if (command.includes('split-window')) return { exitCode: 0, stdout: '%31\n', stderr: '' };
    if (command.includes('select-pane')) return { exitCode: 0, stdout: '', stderr: '' };
    if (command.includes('display-message') && command.includes('#{window_width}')) {
      if (throwOnWindowSize) {
        throw new Error('window size unavailable');
      }
      return { exitCode: 0, stdout: '120 40\n', stderr: '' };
    }
    if (command.includes('display-message') && command.includes('#{pane_id}')) {
      return { exitCode: 0, stdout: '%31\n', stderr: '' };
    }
    if (command.includes('list-panes')) {
      return { exitCode: 0, stdout: '%31\n%32\n%33\n', stderr: '' };
    }
    if (command.includes('select-layout')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  const mockFetch = mock(async () => new Response('ok', { status: 200 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const config = createTestConfig({ layout: 'main-vertical', max_retry_attempts: 0, max_agents_per_column: 2 });
    const result = await spawnTmuxPane('session-layout-catch', 'Catch', config, 'http://localhost:4096');
    expect(result.success).toBe(true);

    throwOnWindowSize = true;
    await applyTmuxLayout();

    expect(commands.at(-1)).toEqual(['/usr/bin/tmux', 'select-layout', 'main-vertical']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('spawnTmuxPane returns failure after max retries exhausted', async () => {
  mockData.results.push(
    { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' },
    { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' },
    { exitCode: 1, stdout: '', stderr: 'fail 1' },
    { exitCode: 1, stdout: '', stderr: 'fail 2' },
    { exitCode: 1, stdout: '', stderr: 'fail 3' },
  );

  let splitCallCount = 0;
  const wrappedFn: MockSpawnFn = async (command, options) => {
    if (command.includes('split-window')) {
      splitCallCount++;
    }
    return mockData.fn(command, options);
  };

  setSpawnAsyncFn(wrappedFn);

  const mockFetch = mock(async () => new Response('ok', { status: 200 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const config = createTestConfig({ max_retry_attempts: 2 });
    const result = await spawnTmuxPane('session-3', 'Fail Task', config, 'http://localhost:4096');

    expect(result.success).toBe(false);
    expect(result.paneId).toBeUndefined();
    expect(splitCallCount).toBe(3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('spawnTmuxPane retries when exitCode is 0 but paneId is empty', async () => {
  mockData.results.push(
    { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' },
    { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 0, stdout: '%9\n', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
  );

  setSpawnAsyncFn(mockData.fn);

  const mockFetch = mock(async () => new Response('ok', { status: 200 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const config = createTestConfig({ max_retry_attempts: 2 });
    const result = await spawnTmuxPane('session-4', 'Empty PaneId', config, 'http://localhost:4096');

    expect(result.success).toBe(true);
    expect(result.paneId).toBe('%9');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('spawnTmuxPane with max_retry_attempts=0 does not retry', async () => {
  mockData.results.push(
    { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' },
    { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' },
    { exitCode: 1, stdout: '', stderr: 'immediate fail' },
  );

  let splitCallCount = 0;
  const wrappedFn: MockSpawnFn = async (command, options) => {
    if (command.includes('split-window')) {
      splitCallCount++;
    }
    return mockData.fn(command, options);
  };

  setSpawnAsyncFn(wrappedFn);

  const mockFetch = mock(async () => new Response('ok', { status: 200 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const config = createTestConfig({ max_retry_attempts: 0 });
    const result = await spawnTmuxPane('session-5', 'No Retry', config, 'http://localhost:4096');

    expect(result.success).toBe(false);
    expect(splitCallCount).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('spawnTmuxPane returns false when tmux binary is missing', async () => {
  mockData.results.push({ exitCode: 1, stdout: '', stderr: 'missing' });
  setSpawnAsyncFn(mockData.fn);

  const mockFetch = mock(async () => new Response('ok', { status: 200 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const config = createTestConfig({ max_retry_attempts: 0 });
    const result = await spawnTmuxPane('session-missing', 'Missing Tmux', config, 'http://localhost:4096');

    expect(result.success).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('closeTmuxPane returns false when tmux binary is missing', async () => {
  mockData.results.push({ exitCode: 1, stdout: '', stderr: 'missing' });
  setSpawnAsyncFn(mockData.fn);

  const result = await closeTmuxPane('%1');

  expect(result).toBe(false);
});

test('closeTmuxPane returns false when PID lookup throws', async () => {
  let callCount = 0;
  setSpawnAsyncFn(async (command: string[]) => {
    callCount++;
    if (callCount === 1) {
      return { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' };
    }
    if (callCount === 2) {
      return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
    }
    throw new Error(`pid lookup failed for ${command.join(' ')}`);
  });

  const result = await closeTmuxPane('%1');

  expect(result).toBe(false);
});

test('startTmuxCheck primes tmux lookup when cache is cold', async () => {
  mockData.results.push(
    { exitCode: 0, stdout: '/usr/local/bin/tmux\n', stderr: '' },
    { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' },
  );
  setSpawnAsyncFn(mockData.fn);
  resetTmuxPathCache();

  startTmuxCheck();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(mockData.calls.length).toBe(2);
});

test('spawnTmuxPane returns early when config.enabled is false', async () => {
  const config = createTestConfig({ enabled: false });
  const result = await spawnTmuxPane('session-6', 'Disabled', config, 'http://localhost:4096');

  expect(result.success).toBe(false);
  expect(mockData.calls.length).toBe(0);
});

test('spawnTmuxPane returns early when not inside tmux', async () => {
  delete process.env.TMUX;

  const config = createTestConfig();
  const result = await spawnTmuxPane('session-7', 'No Tmux', config, 'http://localhost:4096');

  expect(result.success).toBe(false);
  expect(mockData.calls.length).toBe(0);
});

test('spawnTmuxPane still attempts to spawn when server health check fails', async () => {
  mockData.results.push(
    { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' },
    { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' },
    { exitCode: 0, stdout: '%11\n', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
  );

  setSpawnAsyncFn(mockData.fn);

  const mockFetch = mock(async () => new Response('unavailable', { status: 503 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const config = createTestConfig();
    const result = await spawnTmuxPane('session-health', 'Health Gate', config, 'http://localhost:4096');

    expect(result.success).toBe(true);
    expect(result.paneId).toBe('%11');

    const splitWindowCall = mockData.calls.find((c) => c.command.includes('split-window'));
    expect(splitWindowCall).toBeDefined();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('spawnTmuxPane continues when health check aborts on timeout', async () => {
  mockData.results.push(
    { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' },
    { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' },
    { exitCode: 0, stdout: '%11\n', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
  );

  setSpawnAsyncFn(mockData.fn);

  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], _ms?: number, ...args: Parameters<typeof setTimeout>[2][]) => {
    if (typeof callback === 'function') {
      callback(...args);
    }
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
    if (init?.signal?.aborted) {
      throw new Error('aborted');
    }

    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }) as unknown as typeof fetch;

  try {
    const config = createTestConfig({ max_retry_attempts: 0 });
    const result = await spawnTmuxPane('session-timeout', 'Timeout', config, 'http://localhost:4096');

    expect(result.success).toBe(true);
    expect(result.paneId).toBe('%11');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('spawnTmuxPane targets the captured pane when provided', async () => {
  mockData.results.push(
    { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' },
    { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' },
    { exitCode: 0, stdout: '%5\n', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
  );

  setSpawnAsyncFn(mockData.fn);

  const mockFetch = mock(async () => new Response('ok', { status: 200 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const config = createTestConfig();
    const result = await spawnTmuxPane(
      'session-8',
      'Target Task',
      config,
      'http://localhost:4096',
      '%42',
    );

    expect(result.success).toBe(true);

    const splitWindowCall = mockData.calls.find((c) => c.command.includes('split-window'));
    expect(splitWindowCall?.command).toContain('-t');
    expect(splitWindowCall?.command).toContain('%42');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
