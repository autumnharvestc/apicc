export interface EnvironmentChoice {
  key: string;
  name: string;
}

export function environmentIdForLegacyName(options: readonly EnvironmentChoice[], name: string | null): string | undefined {
  if (!name) return undefined;
  const matches = options.filter(option => option.name === name);
  return matches.length === 1 ? matches[0]!.key : undefined;
}

export function legacyEnvironmentName(options: readonly EnvironmentChoice[], id: string | null): string | undefined {
  const name = options.find(option => option.key === id)?.name;
  return name && environmentIdForLegacyName(options, name) === id ? name : undefined;
}
