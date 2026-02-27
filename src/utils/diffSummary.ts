import { DiffFile, DiffHunk, DiffLine, FileSummary } from '../types';

export const SUMMARY_HEAD_LINES = 3;
export const SUMMARY_TAIL_LINES = 3;

export function buildFileSummaries(parsedDiff: DiffFile[], filesChanged: string[] = []): FileSummary[] {
  const summaries: FileSummary[] = [];
  const seen = new Set<string>();

  for (const file of parsedDiff) {
    const additions = file.hunks.reduce((sum, hunk) => sum + countLines(hunk, 'add'), 0);
    const deletions = file.hunks.reduce((sum, hunk) => sum + countLines(hunk, 'del'), 0);
    const hunks = file.hunks.length;
    const path = file.path || '';
    if (!path) continue;
    summaries.push({
      path,
      hunks,
      additions,
      deletions,
      linesChanged: additions + deletions
    });
    seen.add(path);
  }

  for (const path of filesChanged) {
    if (!path || seen.has(path)) continue;
    summaries.push({
      path,
      hunks: 0,
      additions: 0,
      deletions: 0,
      linesChanged: 0
    });
  }

  summaries.sort((a, b) => a.path.localeCompare(b.path));
  return summaries;
}

export function buildHunkCoordinateIndex(files: DiffFile[]): Array<{ path: string; hunks: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number }> }> {
  return files.map(file => ({
    path: file.path,
    hunks: file.hunks.map(hunk => ({
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines
    }))
  }));
}

export function renderGroupDiff(files: DiffFile[], mode: 'full' | 'summary'): string {
  const parts: string[] = [];

  for (const file of files) {
    parts.push(`diff --git a/${file.path} b/${file.path}`);
    parts.push(`--- a/${file.path}`);
    parts.push(`+++ b/${file.path}`);

    for (const hunk of file.hunks) {
      parts.push(renderHunk(hunk, mode));
    }
  }

  return parts.join('\n');
}

function renderHunk(hunk: DiffHunk, mode: 'full' | 'summary'): string {
  const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  if (mode === 'full') {
    const lines = hunk.lines.map(line => `${linePrefix(line)}${line.content}`);
    return [header, ...lines].join('\n');
  }

  const additions = countLines(hunk, 'add');
  const deletions = countLines(hunk, 'del');
  const context = hunk.lines.length - additions - deletions;
  const changed = hunk.lines.filter(line => line.type !== 'context');

  const head = changed.slice(0, SUMMARY_HEAD_LINES);
  const tail = changed.length > SUMMARY_HEAD_LINES + SUMMARY_TAIL_LINES
    ? changed.slice(-SUMMARY_TAIL_LINES)
    : changed.slice(SUMMARY_HEAD_LINES);
  const omitted = Math.max(0, changed.length - head.length - tail.length);

  const summaryLines: string[] = [
    header,
    `(summary: +${additions} -${deletions}, context ${context})`
  ];

  if (head.length > 0) {
    summaryLines.push(...head.map(line => `${linePrefix(line)}${line.content}`));
  }

  if (omitted > 0) {
    summaryLines.push(`... (${omitted} changed lines omitted)`);
  }

  if (tail.length > 0) {
    summaryLines.push(...tail.map(line => `${linePrefix(line)}${line.content}`));
  }

  return summaryLines.join('\n');
}

function countLines(hunk: DiffHunk, type: DiffLine['type']): number {
  return hunk.lines.reduce((sum, line) => sum + (line.type === type ? 1 : 0), 0);
}

function linePrefix(line: DiffLine): string {
  if (line.type === 'add') return '+';
  if (line.type === 'del') return '-';
  return ' ';
}
