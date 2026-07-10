export interface DiscordNameSource {
  username?: string | null | undefined;
  globalName?: string | null | undefined;
  tag?: string | null | undefined;
  displayName?: string | null | undefined;
}

export function normalizeDiscordUsername(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

export function normalizeDiscordUsernames(values: Iterable<string>): string[] {
  return [...new Set([...values].map(normalizeDiscordUsername).filter(Boolean))];
}

export function discordUsernamesFor(source: DiscordNameSource): string[] {
  const names = [
    source.username,
    source.tag,
    source.tag?.split("#")[0]
  ];

  return normalizeDiscordUsernames(names.filter((name): name is string => Boolean(name?.trim())));
}

export function isApprovedDiscordUsername(source: DiscordNameSource, approvedUsernames: ReadonlySet<string> | readonly string[]): boolean {
  const approved = approvedUsernames instanceof Set ? approvedUsernames : new Set(approvedUsernames);
  if (approved.size === 0) {
    return false;
  }

  return discordUsernamesFor(source).some((name) => approved.has(name));
}
