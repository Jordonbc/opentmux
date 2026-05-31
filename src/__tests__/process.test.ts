import { afterEach, describe, expect, mock, spyOn, test, beforeAll, afterAll } from 'bun:test';
import { spawn } from 'node:child_process';
import * as processUtils from '../utils/process';
import {
  isProcessAlive,
  getProcessCommand,
  getProcessChildren,
  getProcessStartTime,
  safeExec,
  safeKill,
  waitForProcessExit,
  findProcessIds
} from '../utils/process';

describe('Process Utilities', () => {
  let childPid: number;
  let childProcess: any;

  afterEach(() => {
    mock.restore();
  });

  beforeAll(() => {
    // Spawn a long-running process (sleep) for testing
    // Use a unique argument to identify it easily
    childProcess = spawn('sleep', ['103']);
    childPid = childProcess.pid;
    console.log('Spawned test process:', childPid);
  });

  afterAll(() => {
    try {
      if (childProcess) childProcess.kill('SIGKILL');
    } catch {}
  });

  test('isProcessAlive returns true for running process', () => {
    expect(isProcessAlive(childPid)).toBe(true);
  });

  test('isProcessAlive returns false for non-existent process', () => {
    expect(isProcessAlive(99999999)).toBe(false);
  });

  test('getProcessCommand returns command string', () => {
    const cmd = getProcessCommand(childPid);
    expect(cmd).toBeDefined();
    expect(cmd).toContain('sleep');
  });

  test('getProcessChildren returns array of children', () => {
    const children = getProcessChildren(process.pid);
    expect(Array.isArray(children)).toBe(true);
  });

  test('safeExec trims successful output and returns null on failure', () => {
    expect(safeExec("printf ' hello '\n" )).toBe('hello');
    expect(safeExec('command-that-does-not-exist-xyz')).toBeNull();
  });

  test('getProcessStartTime parses start time and returns null on missing output', () => {
    const safeExecSpy = spyOn(processUtils, 'safeExec')
      .mockReturnValueOnce('Wed Feb  5 14:00:00 2025')
      .mockReturnValueOnce(null);

    expect(getProcessStartTime(1234)).toBe(Date.parse('Wed Feb  5 14:00:00 2025'));
    expect(getProcessStartTime(5678)).toBeNull();
    expect(safeExecSpy).toHaveBeenCalledTimes(2);
  });

  test('getProcessChildren filters invalid pids from output', () => {
    spyOn(processUtils, 'safeExec').mockReturnValue('123\nabc\n456\n');

    expect(getProcessChildren(process.pid)).toEqual([123, 456]);
  });

  test('getListeningPids filters invalid pids from output', () => {
    spyOn(processUtils, 'safeExec').mockReturnValue('789\nxyz\n321\n');

    expect(processUtils.getListeningPids(4096)).toEqual([789, 321]);
  });

  test('safeKill sends signal', () => {
    const proc = spawn('sleep', ['50']);
    const pid = proc.pid as number;
    expect(isProcessAlive(pid)).toBe(true);
    
    const result = safeKill(pid, 'SIGTERM');
    expect(result).toBe(true);
    
    proc.kill('SIGKILL');
  });

  test('safeKill treats ESRCH as success and other errors as failure', () => {
    const esrchError = Object.assign(new Error('missing'), { code: 'ESRCH' });
    const killSpy = spyOn(process, 'kill')
      .mockImplementationOnce(() => {
        throw esrchError;
      })
      .mockImplementationOnce(() => {
        throw new Error('boom');
      });

    expect(safeKill(12345)).toBe(true);
    expect(safeKill(12345)).toBe(false);
    expect(killSpy).toHaveBeenCalledTimes(2);
  });

  test('waitForProcessExit waits for process to die', async () => {
    const proc = spawn('sleep', ['0.1']);
    const pid = proc.pid as number;
    
    const start = Date.now();
    const exited = await waitForProcessExit(pid, 1000);
    const end = Date.now();
    
    expect(exited).toBe(true);
    expect(isProcessAlive(pid)).toBe(false);
    expect(end - start).toBeLessThan(1100);
  });

  test('waitForProcessExit returns false after timeout when process stays alive', async () => {
    spyOn(processUtils, 'isProcessAlive').mockReturnValue(true);

    const exited = await waitForProcessExit(1234, 1);
    expect(exited).toBe(false);
  });
  
  test('findProcessIds returns matching pids', () => {
    const pids = findProcessIds('sleep 103');
    expect(pids).toContain(childPid);
  });
});
