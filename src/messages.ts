export function neutralizeMentions(value: string): string {
  return value.replace(/@/g, "@\u200b");
}

export function splitDiscordMessage(message: string, maxLength = 1900): string[] {
  if (message.length <= maxLength) {
    return [message];
  }

  const chunks: string[] = [];
  let remaining = message;

  while (remaining.length > maxLength) {
    const breakAt = findBreakPoint(remaining, maxLength);
    chunks.push(remaining.slice(0, breakAt).trimEnd());
    remaining = remaining.slice(breakAt).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function findBreakPoint(value: string, maxLength: number): number {
  const candidates = [value.lastIndexOf("\n\n", maxLength), value.lastIndexOf("\n", maxLength), value.lastIndexOf(" ", maxLength)];
  return candidates.find((candidate) => candidate > maxLength * 0.6) ?? maxLength;
}
