import { tokenizeDiff, canHighlight, TokenizedLineHtml } from '../utils/highlighter';
import { logger } from '../utils';
import { GroupContent } from '../types';

/**
 * Escape HTML for use in JSON.
 */
export function escapeHtmlForJson(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Transform group content to side-by-side format for the UI.
 * Tokenizes code for syntax highlighting in parallel for better performance.
 */
export async function transformGroupContent(group: GroupContent): Promise<any> {
  const hunkPromises: Promise<any>[] = [];

  for (const file of (group.files || [])) {
    for (const hunk of (file.hunks || [])) {
      const lines = hunk.lines || [];

      const hunkPromise = (async () => {
        let tokenizedLines: TokenizedLineHtml[] = [];

        if (lines.length > 0 && canHighlight(file.path)) {
          try {
            tokenizedLines = await tokenizeDiff(file.path, lines);
          } catch (e) {
            logger.warn('reviewPanelTransforms', 'Tokenization failed', { file: file.path, error: String(e) });
            tokenizedLines = lines.map(l => ({
              type: l.type,
              html: escapeHtmlForJson(l.content)
            }));
          }
        } else {
          tokenizedLines = lines.map(l => ({
            type: l.type,
            html: escapeHtmlForJson(l.content)
          }));
        }

        return {
          filePath: file.path,
          oldStart: hunk.oldStart,
          oldLines: hunk.oldLines,
          newStart: hunk.newStart,
          newLines: hunk.newLines,
          lines: lines,
          tokenizedLines: tokenizedLines
        };
      })();

      hunkPromises.push(hunkPromise);
    }
  }

  const hunks = await Promise.all(hunkPromises);

  return {
    id: group.id,
    title: group.title,
    explanation: group.explanation,
    hunks
  };
}
