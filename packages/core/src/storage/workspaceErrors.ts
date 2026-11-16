export class WorkspaceStorageError extends Error {
  constructor(
    readonly reason: "revision-conflict" | "busy" | "read-only" | "unstable",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceStorageError";
  }
}
