/**
 * Simple token estimation utility for deciding when diffs are too large
 * to embed directly in the prompt.
 */

/** Threshold above which we switch to two-pass mode (no full diff prompt). */
export const LARGE_DIFF_TOKEN_THRESHOLD = 80_000;

/** Threshold above which we summarize per-group diffs before prompting. */
export const GROUP_DIFF_TOKEN_THRESHOLD = 20_000;

/**
 * Rough token estimate: ~4 characters per token.
 * Good enough for a go/no-go decision — not meant for billing accuracy.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
