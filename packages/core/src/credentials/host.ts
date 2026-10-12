import { homedir } from "node:os";
import { join } from "node:path";

export function defaultCredentialPrivateRoot(): string {
  return join(homedir(), ".apicc", "private", "test-credentials", "v1");
}
