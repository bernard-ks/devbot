export function tokenizeQuery(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_-]+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 3)
    )
  );
}

export function scoreTextMatches(lowerText: string, terms: string[], capPerTerm = 8): number {
  let score = 0;
  for (const term of terms) {
    const matches = lowerText.split(term).length - 1;
    score += Math.min(matches, capPerTerm);
  }
  return score;
}
