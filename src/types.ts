export interface PluginInput {
  directory: string;
  serverUrl?: URL | string;
  client: {
    session: {
      status(): Promise<{ data?: Record<string, { type: string }> }>;
      subscribe(callback: (event: { type: string; properties?: unknown }) => void): () => void;
    };
  };
}

export interface PluginOutput {
  config?: (config: unknown) => Promise<void>;
  event?: (input: {
    event: {
      type: string;
      properties?: unknown;
    };
  }) => Promise<void>;
  tool?: Record<string, unknown>;
  dispose?: () => Promise<void>;
}

export type Plugin = (ctx: PluginInput) => Promise<PluginOutput>;
