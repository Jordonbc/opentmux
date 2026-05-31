import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';

import { log, logDebug, logError } from '../utils/logger';

const logFile = path.join(os.tmpdir(), 'opencode-agent-tmux.log');
const originalLogLevel = process.env.OPENCODE_TMUX_LOG_LEVEL;

beforeEach(() => {
  fs.rmSync(logFile, { force: true });
});

afterEach(() => {
  mock.restore();
  if (originalLogLevel) {
    process.env.OPENCODE_TMUX_LOG_LEVEL = originalLogLevel;
  } else {
    delete process.env.OPENCODE_TMUX_LOG_LEVEL;
  }
  fs.rmSync(logFile, { force: true });
});

test('logger writes debug logs only when debug level is enabled', () => {
  process.env.OPENCODE_TMUX_LOG_LEVEL = 'debug';
  const appendSpy = spyOn(fs, 'appendFileSync');

  logDebug('[test] debug entry', { ok: true });

  expect(appendSpy).toHaveBeenCalledWith(
    logFile,
    expect.stringContaining('[debug] [test] debug entry'),
  );
  expect(appendSpy).toHaveBeenCalledWith(logFile, expect.stringContaining('"ok":true'));
});

test('logger suppresses info logs when error level is configured', () => {
  process.env.OPENCODE_TMUX_LOG_LEVEL = 'error';
  const appendSpy = spyOn(fs, 'appendFileSync');

  log('[test] info entry');
  logError('[test] error entry');

  expect(appendSpy).toHaveBeenCalledWith(
    logFile,
    expect.stringContaining('[error] [test] error entry'),
  );
  expect(appendSpy).not.toHaveBeenCalledWith(
    logFile,
    expect.stringContaining('[info] [test] info entry'),
  );
});

test('logger disables all file logging when level is off', () => {
  process.env.OPENCODE_TMUX_LOG_LEVEL = 'off';
  const appendSpy = spyOn(fs, 'appendFileSync');

  logError('[test] should not be written');

  expect(appendSpy).not.toHaveBeenCalled();
});

test('logger treats trace as debug and none as off', () => {
  process.env.OPENCODE_TMUX_LOG_LEVEL = 'trace';
  const appendSpy = spyOn(fs, 'appendFileSync');

  logDebug('[test] trace entry');
  expect(appendSpy).toHaveBeenCalledWith(
    logFile,
    expect.stringContaining('[debug] [test] trace entry'),
  );

  fs.rmSync(logFile, { force: true });
  process.env.OPENCODE_TMUX_LOG_LEVEL = 'none';

  logError('[test] none entry');
  expect(appendSpy).toHaveBeenCalledTimes(1);
});

test('logger falls back to string serialization for circular data', () => {
  process.env.OPENCODE_TMUX_LOG_LEVEL = 'debug';
  const appendSpy = spyOn(fs, 'appendFileSync');

  const circular: Record<string, unknown> = {};
  circular.self = circular;

  log('[test] circular entry', circular);

  expect(appendSpy).toHaveBeenCalledWith(
    logFile,
    expect.stringContaining('[info] [test] circular entry'),
  );
  expect(appendSpy).toHaveBeenCalledWith(logFile, expect.stringContaining('[object Object]'));
});

test('logger treats empty and unknown levels as info', () => {
  process.env.OPENCODE_TMUX_LOG_LEVEL = '';
  const appendSpy = spyOn(fs, 'appendFileSync');
  log('[test] empty level info');

  expect(appendSpy).toHaveBeenCalledWith(
    logFile,
    expect.stringContaining('[info] [test] empty level info'),
  );

  fs.rmSync(logFile, { force: true });
  process.env.OPENCODE_TMUX_LOG_LEVEL = 'mystery';
  logDebug('[test] unknown level debug');

  expect(appendSpy).toHaveBeenCalledTimes(1);
});

test('logger swallows appendFileSync failures', () => {
  process.env.OPENCODE_TMUX_LOG_LEVEL = 'debug';
  const appendSpy = spyOn(fs, 'appendFileSync').mockImplementation(() => {
    throw new Error('disk full');
  });

  expect(() => logError('[test] should not throw')).not.toThrow();
  expect(appendSpy).toHaveBeenCalled();
});
