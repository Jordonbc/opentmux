import { afterEach, expect, test } from 'bun:test';

import { detectServerUrl } from '../index';

const originalPort = process.env.OPENCODE_PORT;

afterEach(() => {
  if (originalPort) {
    process.env.OPENCODE_PORT = originalPort;
  } else {
    delete process.env.OPENCODE_PORT;
  }
});

test('detectServerUrl uses the default port when OPENCODE_PORT is unset', () => {
  delete process.env.OPENCODE_PORT;
  expect(detectServerUrl()).toBe('http://localhost:4096');
});

test('detectServerUrl uses OPENCODE_PORT when provided', () => {
  process.env.OPENCODE_PORT = '5151';
  expect(detectServerUrl()).toBe('http://localhost:5151');
});
