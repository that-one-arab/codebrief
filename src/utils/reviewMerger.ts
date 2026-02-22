import { DiffFile, DiffLine, GroupContent } from '../types';
import { logger } from './logger';

/** A hunk with line content from parsed diff */
export interface MergedHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/** A file with merged hunks */
export interface MergedFile {
  path: string;
  hunks: MergedHunk[];
}

/** AI response for a group (before merging with diff) */
export interface GroupResponse {
  id?: string;
  title?: string;
  explanation?: string;
  files?: {
    path: string;
    hunks: {
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
    }[];
  }[];
}

/**
 * Merge a single file's hunks with locally parsed diff data.
 */
function mergeFileHunks(file: any, parsedDiff: DiffFile[], groupId?: string): any {
  const parsedFile = parsedDiff.find(pd => pd.path === file.path);
  if (!parsedFile) {
    const hasEmptyPaths = parsedDiff.some(p => !p.path);
    logger.warn('reviewMerger', 'AI-referenced file not found in parsed diff', {
      file: file.path,
      groupId,
      availableFiles: parsedDiff.map(p => p.path || '(empty)'),
      hasEmptyPaths,
      possibleCause: hasEmptyPaths
        ? 'Diff parsing failed to extract file paths - likely git config issue (diff.noprefix or diff.mnemonicPrefix)'
        : 'AI referenced a file not present in the diff'
    });
    return file;
  }

  logger.debug('reviewMerger', 'Merging file hunks', {
    file: file.path,
    groupId,
    aiHunksCount: file.hunks?.length || 0,
    parsedHunksCount: parsedFile.hunks.length
  });

  let exactMatches = 0;
  let approximateMatches = 0;
  let failedMatches = 0;

  const mergedHunks = file.hunks.map((hunk: { oldStart: number; oldLines: number; newStart: number; newLines: number }) => {
    // Try exact match first
    const parsedHunk = parsedFile.hunks.find(ph => 
      ph.oldStart === hunk.oldStart && ph.newStart === hunk.newStart
    );

    if (parsedHunk) {
      exactMatches++;
      return { ...hunk, lines: parsedHunk.lines };
    }

    // Try approximate match
    const approxHunk = parsedFile.hunks.find(ph =>
      Math.abs(ph.oldStart - hunk.oldStart) <= 5 &&
      Math.abs(ph.newStart - hunk.newStart) <= 5
    );

    if (approxHunk) {
      approximateMatches++;
      logger.debug('reviewMerger', 'Using approximate hunk match', { 
        file: file.path, 
        groupId,
        requestedOldStart: hunk.oldStart,
        requestedNewStart: hunk.newStart,
        matchedOldStart: approxHunk.oldStart,
        matchedNewStart: approxHunk.newStart
      });
      return {
        ...hunk,
        oldStart: approxHunk.oldStart,
        oldLines: approxHunk.oldLines,
        newStart: approxHunk.newStart,
        newLines: approxHunk.newLines,
        lines: approxHunk.lines
      };
    }

    failedMatches++;
    logger.warn('reviewMerger', 'Hunk not found in parsed diff', { 
      file: file.path, 
      groupId,
      requestedOldStart: hunk.oldStart,
      requestedOldLines: hunk.oldLines,
      requestedNewStart: hunk.newStart,
      requestedNewLines: hunk.newLines,
      availableParsedHunks: parsedFile.hunks.map(h => ({
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines
      }))
    });
    return null;
  }).filter((hunk: MergedHunk | null): hunk is MergedHunk => hunk !== null);

  logger.debug('reviewMerger', 'File hunks merged', {
    file: file.path,
    groupId,
    exactMatches,
    approximateMatches,
    failedMatches,
    totalHunks: mergedHunks.length
  });

  return { ...file, hunks: mergedHunks };
}

/**
 * Merge AI review analysis with locally parsed diff to add line-by-line content.
 * Works with both full reviews (with groups) and single groups.
 */
export function mergeReviewWithDiff(aiReview: any, parsedDiff: DiffFile[], groupId?: string): any {
  if (!aiReview.files) {
    logger.warn('reviewMerger', 'Invalid AI review format - no files array', {
      groupId,
      groupTitle: aiReview.title,
      availableKeys: Object.keys(aiReview)
    });
    return aiReview;
  }

  logger.debug('reviewMerger', 'Starting merge of AI group with parsed diff', {
    groupId: groupId || aiReview.id,
    groupTitle: aiReview.title,
    filesInGroup: aiReview.files.length,
    filesInParsedDiff: parsedDiff.length
  });

  const startTime = Date.now();
  
  const result = {
    ...aiReview,
    files: aiReview.files.map((file: any) => mergeFileHunks(file, parsedDiff, groupId || aiReview.id))
  };

  const totalHunks = result.files.reduce((sum: number, f: any) => sum + (f.hunks?.length || 0), 0);
  
  logger.debug('reviewMerger', 'Merge complete', {
    groupId: groupId || aiReview.id,
    groupTitle: aiReview.title,
    durationMs: Date.now() - startTime,
    filesProcessed: result.files.length,
    totalHunks
  });

  return result;
}

export interface UncoveredHunk {
  path: string;
  oldStart: number;
  newStart: number;
}

/**
 * Find hunks from the parsed diff that were not referenced by any AI group.
 * Uses the same ±5 approximate matching tolerance as mergeFileHunks.
 */
export function findUncoveredHunks(
  parsedDiff: DiffFile[],
  groups: Map<string, GroupContent>
): UncoveredHunk[] {
  // Collect all hunk coordinates the AI referenced across all groups
  const coveredKeys = new Set<string>();
  for (const group of groups.values()) {
    for (const file of group.files || []) {
      for (const hunk of file.hunks) {
        coveredKeys.add(`${file.path}:${hunk.oldStart}:${hunk.newStart}`);
      }
    }
  }

  const uncovered: UncoveredHunk[] = [];
  for (const file of parsedDiff) {
    for (const hunk of file.hunks) {
      const exactKey = `${file.path}:${hunk.oldStart}:${hunk.newStart}`;
      if (coveredKeys.has(exactKey)) {
        continue;
      }

      // Check approximate match (±5 lines), same tolerance as mergeFileHunks
      let approxMatch = false;
      for (const key of coveredKeys) {
        if (!key.startsWith(file.path + ':')) { continue; }
        // key is "path:oldStart:newStart", path may contain colons
        const parts = key.split(':');
        const covNewStart = parseInt(parts[parts.length - 1], 10);
        const covOldStart = parseInt(parts[parts.length - 2], 10);
        if (
          Math.abs(covOldStart - hunk.oldStart) <= 5 &&
          Math.abs(covNewStart - hunk.newStart) <= 5
        ) {
          approxMatch = true;
          break;
        }
      }

      if (!approxMatch) {
        uncovered.push({ path: file.path, oldStart: hunk.oldStart, newStart: hunk.newStart });
      }
    }
  }

  if (uncovered.length > 0) {
    logger.warn('reviewMerger', 'Uncovered hunks detected', {
      uncoveredCount: uncovered.length,
      totalParsedHunks: parsedDiff.reduce((sum, f) => sum + f.hunks.length, 0),
      uncovered: uncovered.map(h => `${h.path} @@ -${h.oldStart} +${h.newStart}`)
    });
  }

  return uncovered;
}
