export interface BuildSourceHostResourcesOptions {
  readonly outputDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly powershellPath?: string;
}
export declare function buildSourceHostResources(options: BuildSourceHostResourcesOptions): Promise<void>;
