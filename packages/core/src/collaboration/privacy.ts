/** Known filesystem forms only; business API route fields are projected separately. */
export function redactKnownPrivatePaths(value: string): string {
  return value.replace(/[A-Za-z]:[\\/][^\s"'<>]+/g, "[REDACTED]")
    .replace(/\\\\[^\\\s"'<>]+\\[^\s"'<>]+/g, "[REDACTED]")
    .replace(/\/(?:home|Users|tmp|var|etc|root|mnt|opt|private|srv)\/[^\s"'<>]+/g, "[REDACTED]");
}
