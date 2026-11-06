export interface GitFixtureRepository { readonly commitOid: string; readonly blobOid: string; readonly rawText: string; readonly movedCommitOid: string; readonly movedBlobOid: string; readonly movedRawText: string }
export interface GitSourceFixture {
  readonly directory: string;
  readonly container: string;
  readonly transport: 'host' | 'bridge';
  readonly address: string;
  readonly hostname: string;
  readonly sshPort: number;
  readonly httpsPort: number;
  readonly crlUrl: string;
  readonly crlRequests: readonly { path: string; remoteAddress: string }[];
  readonly repositories: Readonly<Record<"sha1" | "sha256", GitFixtureRepository>>;
  readonly httpsUrl: string;
  readonly sshUrl: string;
  readonly privateKeyPath: string;
  readonly knownHostsPath: string;
  readonly wrongHostKeyRef: string;
  readonly passphrase: string;
  readonly caPem: string;
  command(args: string[]): Promise<string>;
  exec(args: string[]): Promise<string>;
  uploads(): Promise<string[]>;
  requests(): Promise<{ method: string; path: string; authorization?: string; internalToken?: string; contentType?: string }[]>;
  activeHttpSockets(): Promise<number>;
  pauseUploads(): Promise<string>;
  resumeUploads(): Promise<string>;
  moveBranch(format?: "sha1" | "sha256"): Promise<string>;
  resetBranch(format?: "sha1" | "sha256"): Promise<string>;
  positiveControls(protocols?: readonly ("https" | "ssh")[]): Promise<void>;
  positiveWindowsControls(protocols?: readonly ("https" | "ssh")[]): Promise<unknown>;
}
export declare const fixtureImage: string;
export declare function withGitSource(callback: (fixture: GitSourceFixture) => Promise<void>): Promise<void>;
