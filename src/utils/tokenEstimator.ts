/**
 * Simple token estimation utility for deciding when diffs are too large
 * to embed directly in the prompt.
 */

/** Threshold above which we switch to agent-driven mode (no embedded diff). */
export const LARGE_DIFF_TOKEN_THRESHOLD = 80_000;

/**
 * Rough token estimate: ~4 characters per token.
 * Good enough for a go/no-go decision — not meant for billing accuracy.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
