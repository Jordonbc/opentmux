import { expect, test } from 'bun:test';

import {
  buildMainVerticalMultiColumnLayoutString,
  computeColumnCount,
  distributeAgentsRoundRobin,
  groupAgentsByColumn,
  layoutChecksum,
  mainPanePercentForColumns,
} from '../layout';

test('computeColumnCount handles empty and invalid inputs', () => {
  expect(computeColumnCount(0, 3)).toBe(0);
  expect(computeColumnCount(5, 2)).toBe(3);
  expect(() => computeColumnCount(1, 0)).toThrow('maxAgentsPerColumn must be positive');
});

test('distributeAgentsRoundRobin returns balanced assignments', () => {
  expect(distributeAgentsRoundRobin(0, 3)).toEqual({ numColumns: 0, columnAssignments: [] });
  expect(distributeAgentsRoundRobin(5, 2)).toEqual({
    numColumns: 3,
    columnAssignments: [0, 1, 2, 0, 1],
  });
});

test('groupAgentsByColumn groups items by calculated column', () => {
  expect(groupAgentsByColumn(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([
    ['a', 'd'],
    ['b', 'e'],
    ['c'],
  ]);
});

test('mainPanePercentForColumns uses expected thresholds', () => {
  expect(mainPanePercentForColumns(0)).toBe(60);
  expect(mainPanePercentForColumns(1)).toBe(60);
  expect(mainPanePercentForColumns(2)).toBe(45);
  expect(mainPanePercentForColumns(3)).toBe(30);
});

test('layoutChecksum matches tmux layout_checksum', () => {
  const layout = '80x24,0,0{40x24,0,0,129,39x24,41,0,130}';
  expect(layoutChecksum(layout)).toBe(0x6c56);
});

test('buildMainVerticalMultiColumnLayoutString rejects empty columns', () => {
  expect(() =>
    buildMainVerticalMultiColumnLayoutString({
      windowWidth: 80,
      windowHeight: 24,
      mainPaneWpId: 129,
      columns: [] as number[][],
      mainPanePercent: 45,
    }),
  ).toThrow('columns must be non-empty');
});

test('buildMainVerticalMultiColumnLayoutString prefixes correct checksum', () => {
  const built = buildMainVerticalMultiColumnLayoutString({
    windowWidth: 80,
    windowHeight: 24,
    mainPaneWpId: 129,
    columns: [[130], [131]],
    mainPanePercent: 45,
  });

  const firstComma = built.indexOf(',');
  expect(firstComma).toBeGreaterThan(0);

  const checksumHex = built.slice(0, firstComma);
  expect(checksumHex).toMatch(/^[0-9a-f]{4}$/);

  const layout = built.slice(firstComma + 1);
  const computed = layoutChecksum(layout).toString(16).padStart(4, '0');
  expect(checksumHex).toBe(computed);
});

test('buildMainVerticalMultiColumnLayoutString handles one right-side column with multiple panes', () => {
  const built = buildMainVerticalMultiColumnLayoutString({
    windowWidth: 100,
    windowHeight: 20,
    mainPaneWpId: 129,
    columns: [[130, 131]],
    mainPanePercent: 60,
  });

  const layout = built.slice(built.indexOf(',') + 1);
  expect(layout).toContain('100x20,0,0');
  expect(layout).toContain(',129');
  expect(layout).toContain('39x20,61,0[');
  expect(layout).toContain('39x10,61,0,130');
  expect(layout).toContain('130');
  expect(layout).toContain('131');
});

test('buildMainVerticalMultiColumnLayoutString distributes multiple columns with remainder width', () => {
  const built = buildMainVerticalMultiColumnLayoutString({
    windowWidth: 101,
    windowHeight: 20,
    mainPaneWpId: 1,
    columns: [[2], [3]],
    mainPanePercent: 50,
  });

  const layout = built.slice(built.indexOf(',') + 1);
  expect(layout).toContain('101x20,0,0');
  expect(layout).toContain('50x20,0,0,1');
  expect(layout).toContain('25x20,51,0,2');
  expect(layout).toContain('24x20,77,0,3');
});
