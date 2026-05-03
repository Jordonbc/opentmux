import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PluginConfigSchema, type PluginConfig } from '../config';

function readConfigFile(configPath: string): PluginConfig | null {
  try {
    if (!fs.existsSync(configPath)) {
      return null;
    }

    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content);
    const result = PluginConfigSchema.safeParse(parsed);

    if (result.success) {
      return result.data;
    }

    console.error(
      `[opentmux] Invalid config at ${configPath}: ${result.error.message}`,
    );
  } catch (error) {
    console.error(`[opentmux] Failed to load config at ${configPath}:`, error);
  }

  return null;
}

export function loadConfig(directory?: string): PluginConfig {
  const configPaths: string[] = [];

  if (directory) {
    configPaths.push(path.join(directory, 'opentmux.json'));
    configPaths.push(path.join(directory, 'opencode-agent-tmux.json'));
  }

  const homeDirectory = process.env.HOME ?? os.homedir();
  configPaths.push(path.join(homeDirectory, '.config', 'opencode', 'opentmux.json'));
  configPaths.push(
    path.join(homeDirectory, '.config', 'opencode', 'opencode-agent-tmux.json'),
  );

  for (const configPath of configPaths) {
    const loaded = readConfigFile(configPath);
    if (loaded) {
      return loaded;
    }
  }

  return PluginConfigSchema.parse({});
}
