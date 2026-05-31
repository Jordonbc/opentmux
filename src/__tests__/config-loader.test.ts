import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../utils/config-loader';

const originalHome = process.env.HOME;

beforeEach(() => {
  spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  mock.restore();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

test('loadConfig reads legacy project config file', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentmux-project-'));
  fs.writeFileSync(
    path.join(projectDir, 'opencode-agent-tmux.json'),
    JSON.stringify({ enabled: false, max_ports: 4 }),
  );

  const config = loadConfig(projectDir);

  expect(config.enabled).toBe(false);
  expect(config.max_ports).toBe(4);
});

test('loadConfig uses the home directory config path', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentmux-home-'));
  const configDir = path.join(homeDir, '.config', 'opencode');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'opentmux.json'),
    JSON.stringify({ enabled: false, layout: 'tiled' }),
  );

  process.env.HOME = homeDir;

  const config = loadConfig();

  expect(config.enabled).toBe(false);
  expect(config.layout).toBe('tiled');
});

test('loadConfig ignores invalid json and falls back to valid config', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentmux-invalid-json-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentmux-home-fallback-'));
  const configDir = path.join(homeDir, '.config', 'opencode');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'opentmux.json'), '{invalid json');
  fs.writeFileSync(
    path.join(configDir, 'opentmux.json'),
    JSON.stringify({ enabled: true, layout: 'tiled' }),
  );

  process.env.HOME = homeDir;

  const config = loadConfig(projectDir);

  expect(config.enabled).toBe(true);
  expect(config.layout).toBe('tiled');
});

test('loadConfig reports schema errors and falls back to defaults when nothing is valid', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentmux-invalid-schema-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentmux-empty-home-'));
  fs.writeFileSync(
    path.join(projectDir, 'opentmux.json'),
    JSON.stringify({ enabled: 'nope', max_ports: 'bad' }),
  );

  process.env.HOME = homeDir;

  const config = loadConfig(projectDir);

  expect(config.enabled).toBe(true);
  expect(config.layout).toBe('main-vertical');
});
