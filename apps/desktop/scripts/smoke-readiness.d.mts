export interface RendererDocument {
  url: string;
  readyState: string;
  title: string;
  children: number;
}

export function waitForRendererReady(options: {
  deadline: number;
  observe: (timeoutMs: number) => Promise<RendererDocument | null | undefined>;
  isAlive: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<RendererDocument>;
