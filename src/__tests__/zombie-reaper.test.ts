import { test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { ZombieReaper } from '../zombie-reaper';
import * as processUtils from '../utils/process';

// Mock dependencies
const mockFetch = mock();
globalThis.fetch = mockFetch as any;

const DEFAULT_OPTIONS = {
  enabled: true,
  intervalMs: 100,
  minZombieChecks: 3,
  gracePeriodMs: 5000,
};

let reaper: ZombieReaper;

beforeEach(() => {
  mockFetch.mockReset();
  // Return a NEW response every time
  mockFetch.mockImplementation(async (_url: string) => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  
  // Default mocks
  spyOn(processUtils, 'findProcessIds').mockReturnValue([]);
  spyOn(processUtils, 'getProcessCommand').mockReturnValue('opencode attach --session ses_123');
  spyOn(processUtils, 'safeKill').mockReturnValue(true);
  
  reaper = new ZombieReaper('http://localhost:4096', DEFAULT_OPTIONS);
});

afterEach(() => {
  reaper.stop();
  mock.restore();
});

test('findAllAttachProcesses parses session IDs', async () => {
  spyOn(processUtils, 'findProcessIds').mockReturnValue([100, 101]);
  spyOn(processUtils, 'getProcessCommand').mockImplementation((pid) => {
    if (pid === 100) return 'opencode attach http://localhost:4096 --session ses_active';
    if (pid === 101) return 'opencode attach http://localhost:4096 --session ses_zombie';
    return null;
  });

  const processes = await reaper.findAllAttachProcesses();
  
  expect(processes.length).toBe(2);
  expect(processes[0]).toEqual({ 
    pid: 100, 
    sessionId: 'ses_active', 
    targetUrl: 'http://localhost:4096',
    command: expect.stringContaining('ses_active') 
  });
  expect(processes[1]).toEqual({ 
    pid: 101, 
    sessionId: 'ses_zombie', 
    targetUrl: 'http://localhost:4096',
    command: expect.stringContaining('ses_zombie') 
  });
});

test('scanOnce filters by serverUrl', async () => {
  // Reaper configured for 4096
  reaper = new ZombieReaper('http://localhost:4096', DEFAULT_OPTIONS);
  
  spyOn(processUtils, 'findProcessIds').mockReturnValue([200, 201]);
  spyOn(processUtils, 'getProcessCommand').mockImplementation((pid) => {
    if (pid === 200) return 'opencode attach http://localhost:4096 --session ses_mine';
    if (pid === 201) return 'opencode attach http://localhost:4097 --session ses_other';
    return null;
  });

  // Mock server 4096 to have NO sessions (so ses_mine is zombie)
  mockFetch.mockImplementation(async (_url: string) => {
    if (_url.includes('4096')) return new Response(JSON.stringify({ data: {} }), { status: 200 });
    return new Response(JSON.stringify({ data: { ses_other: {} } }), { status: 200 }); // 4097 has session
  });

  // Mock Date.now to force kill condition
  spyOn(Date, 'now').mockReturnValue(1000000);
  
  // Scan 1
  await reaper.scanOnce();
  
  // Should only track 200 (mine), not 201 (other)
  // But wait, it needs 3 checks to kill.
  // We can't check internal map easily without exposing it, but we can verify calls.
  
  // ... (Test logic simplified: verifying filtering is hard without checking internal state or mocking fetch calls strictly)
  // Let's verify fetch is ONLY called for 4096
  expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('4096'), expect.anything());
  expect(mockFetch).not.toHaveBeenCalledWith(expect.stringContaining('4097'), expect.anything());
});

test('classifyProcess identifies active sessions', async () => {
  mockFetch.mockImplementation(async () => new Response(JSON.stringify({
    data: { 'ses_active': { type: 'idle' } }
  }), { status: 200 }));

  const status = await reaper.classifyProcess('ses_active');
  expect(status).toBe('active');
});

test('classifyProcess identifies zombie sessions', async () => {
  mockFetch.mockImplementation(async () => new Response(JSON.stringify({
    data: { 'ses_other': { type: 'idle' } }
  }), { status: 200 }));

  const status = await reaper.classifyProcess('ses_zombie');
  expect(status).toBe('zombie');
});

test('classifyProcess returns unknown if server fails', async () => {
  mockFetch.mockRejectedValue(new Error('Network error'));

  const status = await reaper.classifyProcess('ses_any');
  expect(status).toBe('unknown');
});

test('areUrlsEqual normalizes localhost and missing protocol', () => {
  const areUrlsEqual = (reaper as unknown as {
    areUrlsEqual: (url1: string | null, url2: string) => boolean;
  }).areUrlsEqual;

  expect(areUrlsEqual('localhost:4096', 'http://127.0.0.1:4096')).toBe(true);
  expect(areUrlsEqual('http://localhost:4096', 'https://localhost:4096')).toBe(false);
  expect(areUrlsEqual(null, 'http://localhost:4096')).toBe(false);
});

test('fetchActiveSessions accepts raw session maps', async () => {
  mockFetch.mockImplementation(async () => new Response(JSON.stringify({
    ses_one: {},
    ses_two: {},
  }), { status: 200 }));

  const fetchActiveSessions = (reaper as unknown as {
    fetchActiveSessions: (url: string) => Promise<Set<string> | null>;
  }).fetchActiveSessions;

  const sessions = await fetchActiveSessions('http://localhost:4096');
  expect(sessions).toEqual(new Set(['ses_one', 'ses_two']));
});

test('fetchActiveSessions accepts array session payloads', async () => {
  mockFetch.mockImplementation(async () => new Response(JSON.stringify({
    data: [
      { id: 'ses_arr_one' },
      { sessionId: 'ses_arr_two' },
    ],
  }), { status: 200 }));

  const fetchActiveSessions = (reaper as unknown as {
    fetchActiveSessions: (url: string) => Promise<Set<string> | null>;
  }).fetchActiveSessions;

  const sessions = await fetchActiveSessions('http://localhost:4096');
  expect(sessions).toEqual(new Set(['ses_arr_one', 'ses_arr_two']));
});

test('fetchActiveSessions returns null for invalid JSON payloads', async () => {
  mockFetch.mockImplementation(async () => new Response('not-json', { status: 200 }));

  const fetchActiveSessions = (reaper as unknown as {
    fetchActiveSessions: (url: string) => Promise<Set<string> | null>;
  }).fetchActiveSessions;

  const sessions = await fetchActiveSessions('http://localhost:4096');
  expect(sessions).toBeNull();
});

test('reapServers handles fetch errors while cleaning unreachable servers', async () => {
  spyOn(processUtils, 'getListeningPids').mockReturnValue([991]);
  spyOn(processUtils, 'getProcessCommand').mockReturnValue('opencode --port 4096');
  spyOn(processUtils, 'waitForProcessExit').mockResolvedValue(false);
  const safeKillSpy = spyOn(processUtils, 'safeKill').mockReturnValue(true);

  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], _ms?: number, ...args: Parameters<typeof setTimeout>[2][]) => {
    if (typeof callback === 'function') {
      callback(...args);
    }
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;

  try {
    const reaped = await ZombieReaper.reapServers(4096, 4096);
    expect(reaped).toBe(1);
    expect(safeKillSpy).toHaveBeenCalledWith(991, 'SIGTERM');
    expect(safeKillSpy).toHaveBeenCalledWith(991, 'SIGKILL');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('reapServers handles fetchActiveSessions rejection through outer catch', async () => {
  spyOn(processUtils, 'getListeningPids').mockReturnValue([992]);
  spyOn(processUtils, 'getProcessCommand').mockReturnValue('opencode --port 4096');
  spyOn(processUtils, 'waitForProcessExit').mockResolvedValue(false);
  const safeKillSpy = spyOn(processUtils, 'safeKill').mockReturnValue(true);

  const fetchSpy = spyOn(
    ZombieReaper.prototype as unknown as {
      fetchActiveSessions: (url: string) => Promise<Set<string> | null>;
    },
    'fetchActiveSessions',
  ).mockRejectedValue(new Error('status endpoint exploded'));

  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], _ms?: number, ...args: Parameters<typeof setTimeout>[2][]) => {
    if (typeof callback === 'function') {
      callback(...args);
    }
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    const reaped = await ZombieReaper.reapServers(4096, 4096);
    expect(reaped).toBe(1);
    expect(fetchSpy).toHaveBeenCalled();
    expect(safeKillSpy).toHaveBeenCalledWith(992, 'SIGTERM');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('fetchActiveSessions accepts empty session arrays', async () => {
  mockFetch.mockImplementation(async () => new Response(JSON.stringify({
    data: [],
  }), { status: 200 }));

  const fetchActiveSessions = (reaper as unknown as {
    fetchActiveSessions: (url: string) => Promise<Set<string> | null>;
  }).fetchActiveSessions;

  const sessions = await fetchActiveSessions('http://localhost:4096');
  expect(sessions).toEqual(new Set());
});

test('shouldKill requires consecutive checks and grace period', () => {
  const fastReaper = new ZombieReaper('url', { ...DEFAULT_OPTIONS, gracePeriodMs: 0 });
  const pid = 123;
  
  fastReaper.markAsZombie(pid);
  expect(fastReaper.shouldKill(pid)).toBe(false);
  
  fastReaper.markAsZombie(pid);
  expect(fastReaper.shouldKill(pid)).toBe(false);
  
  fastReaper.markAsZombie(pid);
  expect(fastReaper.shouldKill(pid)).toBe(true);
});

test('grace period prevents killing new processes', async () => {
  const pid = 999;
  
  reaper.markAsZombie(pid);
  reaper.markAsZombie(pid);
  reaper.markAsZombie(pid);
  
  expect(reaper.shouldKill(pid)).toBe(false);
});

test('scanOnce kills confirmed zombies', async () => {
  // Setup: 1 zombie process
  spyOn(processUtils, 'findProcessIds').mockReturnValue([500]);
  spyOn(processUtils, 'getProcessCommand').mockReturnValue('opencode attach http://localhost:4096 --session ses_zombie');
  
  // Server says no sessions
  mockFetch.mockImplementation(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
  
  const safeKillSpy = spyOn(processUtils, 'safeKill');
  
  // Mock Date.now
  let time = 1000000;
  spyOn(Date, 'now').mockImplementation(() => time);
  
  // 1st scan
  await reaper.scanOnce();
  expect(safeKillSpy).not.toHaveBeenCalled();
  
  // 2nd scan
  await reaper.scanOnce();
  expect(safeKillSpy).not.toHaveBeenCalled();
  
  // 3rd scan
  await reaper.scanOnce();
  expect(safeKillSpy).not.toHaveBeenCalled();
  
  // Advance time > 5s
  time += 6000;
  
  // 4th scan
  await reaper.scanOnce();
  expect(safeKillSpy).toHaveBeenCalledWith(500, 'SIGTERM');
});

test('scanOnce with tracked sessions ignores untracked attach processes', async () => {
  reaper = new ZombieReaper('http://localhost:4096', {
    ...DEFAULT_OPTIONS,
    minZombieChecks: 1,
    gracePeriodMs: 0,
    trackedSessionIds: () => ['ses_child'],
  });

  spyOn(processUtils, 'findProcessIds').mockReturnValue([700, 701]);
  spyOn(processUtils, 'getProcessCommand').mockImplementation((pid) => {
    if (pid === 700) return 'opencode attach http://localhost:4096 --session ses_root';
    if (pid === 701) return 'opencode attach http://localhost:4096 --session ses_child';
    return null;
  });

  mockFetch.mockImplementation(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
  const safeKillSpy = spyOn(processUtils, 'safeKill');

  await reaper.scanOnce();

  expect(safeKillSpy).not.toHaveBeenCalledWith(700, 'SIGTERM');
  expect(safeKillSpy).toHaveBeenCalledWith(701, 'SIGTERM');
});

test('reapAll (manual CLI) kills zombies immediately without grace period', async () => {
  spyOn(processUtils, 'findProcessIds').mockReturnValue([800, 801]);
  spyOn(processUtils, 'getProcessCommand').mockImplementation((pid) => {
    if (pid === 800) return 'opencode attach http://localhost:4096 --session ses_zombie';
    if (pid === 801) return 'opencode attach http://localhost:4097 --session ses_active';
    return null;
  });

  // Mock server responses based on URL
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes('4096')) return new Response(JSON.stringify({ data: {} }), { status: 200 }); // 4096: No sessions -> ses_zombie is zombie
    if (url.includes('4097')) return new Response(JSON.stringify({ data: { ses_active: {} } }), { status: 200 }); // 4097: Has session -> active
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  });
  
  const killSpy = spyOn(processUtils, 'safeKill');
  spyOn(processUtils, 'waitForProcessExit').mockResolvedValue(false);

  await ZombieReaper.reapAll();

  // Should kill 800 (zombie)
  expect(killSpy).toHaveBeenCalledWith(800, 'SIGTERM');
  expect(killSpy).toHaveBeenCalledWith(800, 'SIGKILL');
  
  // Should NOT kill 801 (active)
  expect(killSpy).not.toHaveBeenCalledWith(801, 'SIGTERM');
});

test('reapServers kills inactive opencode servers and ignores attach clients', async () => {
  spyOn(processUtils, 'getListeningPids').mockReturnValue([900, 901]);
  spyOn(processUtils, 'getProcessCommand').mockImplementation((pid) => {
    if (pid === 900) return 'opencode --port 4096';
    if (pid === 901) return 'opencode attach http://localhost:4096 --session ses_attach';
    return null;
  });

  mockFetch.mockImplementation(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
  const safeKillSpy = spyOn(processUtils, 'safeKill');

  await ZombieReaper.reapServers(4096, 4096);

  expect(safeKillSpy).toHaveBeenCalledWith(900, 'SIGTERM');
  expect(safeKillSpy).not.toHaveBeenCalledWith(901, 'SIGTERM');
});

test('reapServers skips unrelated node processes', async () => {
  spyOn(processUtils, 'getListeningPids').mockReturnValue([950]);
  spyOn(processUtils, 'getProcessCommand').mockReturnValue('node server.js');
  const safeKillSpy = spyOn(processUtils, 'safeKill');

  await ZombieReaper.reapServers(4096, 4096);

  expect(safeKillSpy).not.toHaveBeenCalled();
});

test('reapServers skips commands that only contain opencode as a substring', async () => {
  spyOn(processUtils, 'getListeningPids').mockReturnValue([951]);
  spyOn(processUtils, 'getProcessCommand').mockReturnValue('node my-opencode-helper.js --port 4096');
  const safeKillSpy = spyOn(processUtils, 'safeKill');

  await ZombieReaper.reapServers(4096, 4096);

  expect(safeKillSpy).not.toHaveBeenCalled();
});

test('shutdown stops the reaper and runs a final scan', async () => {
  const stopSpy = spyOn(reaper, 'stop');
  const scanOnceSpy = spyOn(reaper, 'scanOnce').mockResolvedValue(undefined);

  await reaper.shutdown();

  expect(stopSpy).toHaveBeenCalledTimes(1);
  expect(scanOnceSpy).toHaveBeenCalledTimes(1);
});

test('private candidate helpers prune missing pids and expose tracked sessions', () => {
  const helperReaper = new ZombieReaper('http://localhost:4096', {
    ...DEFAULT_OPTIONS,
    trackedSessionIds: () => ['ses_keep', 'ses_other'],
  });

  const internal = helperReaper as unknown as {
    pruneCandidates: (currentPids: Set<number>) => void;
    getTrackedSessionIds: () => Set<string> | null;
    candidates: Map<number, { count: number; firstDetectedAt: number }>;
  };

  internal.candidates.set(11, { count: 1, firstDetectedAt: Date.now() });
  internal.candidates.set(12, { count: 2, firstDetectedAt: Date.now() });

  internal.pruneCandidates(new Set([12]));

  expect(internal.candidates.has(11)).toBe(false);
  expect(internal.candidates.has(12)).toBe(true);
  expect(internal.getTrackedSessionIds()).toEqual(new Set(['ses_keep', 'ses_other']));
});

test('reapServers retries unreachable servers before killing them', async () => {
  spyOn(processUtils, 'getListeningPids').mockReturnValue([990]);
  spyOn(processUtils, 'getProcessCommand').mockReturnValue('opencode --port 4096');
  spyOn(processUtils, 'safeKill').mockReturnValue(true);
  spyOn(processUtils, 'waitForProcessExit').mockResolvedValue(true);

  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], _ms?: number, ...args: Parameters<typeof setTimeout>[2][]) => {
    if (typeof callback === 'function') {
      callback(...args);
    }
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;

  try {
    const reaped = await ZombieReaper.reapServers(4096, 4096);

    expect(reaped).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('forceKill escalates to SIGKILL when SIGTERM does not exit', async () => {
  const helperReaper = new ZombieReaper('http://localhost:4096', DEFAULT_OPTIONS);
  const internal = helperReaper as unknown as {
    forceKill: (pid: number) => Promise<void>;
  };

  const safeKillSpy = spyOn(processUtils, 'safeKill').mockReturnValue(true);
  spyOn(processUtils, 'waitForProcessExit').mockResolvedValue(false);

  await internal.forceKill(321);

  expect(safeKillSpy).toHaveBeenCalledWith(321, 'SIGTERM');
  expect(safeKillSpy).toHaveBeenCalledWith(321, 'SIGKILL');
});

test('reapProcess removes the candidate after successful cleanup', async () => {
  const helperReaper = new ZombieReaper('http://localhost:4096', DEFAULT_OPTIONS);
  const internal = helperReaper as unknown as {
    reapProcess: (proc: { pid: number; sessionId: string; command: string; targetUrl: string | null }) => Promise<void>;
    candidates: Map<number, { count: number; firstDetectedAt: number }>;
  };

  internal.candidates.set(777, { count: 2, firstDetectedAt: Date.now() });
  const safeKillSpy = spyOn(processUtils, 'safeKill').mockReturnValue(true);
  spyOn(processUtils, 'waitForProcessExit').mockResolvedValue(false);

  await internal.reapProcess({
    pid: 777,
    sessionId: 'ses_777',
    command: 'opencode attach http://localhost:4096 --session ses_777',
    targetUrl: 'http://localhost:4096',
  });

  expect(safeKillSpy).toHaveBeenCalledWith(777, 'SIGTERM');
  expect(safeKillSpy).toHaveBeenCalledWith(777, 'SIGKILL');
  expect(internal.candidates.has(777)).toBe(false);
});

test('reapAll scans configured port range', async () => {
  const listeningSpy = spyOn(processUtils, 'getListeningPids').mockReturnValue([]);
  spyOn(processUtils, 'findProcessIds').mockReturnValue([]);

  await ZombieReaper.reapAll({ startPort: 5000, maxPorts: 2 });

  expect(listeningSpy).toHaveBeenCalledWith(5000);
  expect(listeningSpy).toHaveBeenCalledWith(5001);
  expect(listeningSpy).not.toHaveBeenCalledWith(4096);
});
