/**
 * Lightweight git diff parser - extracts hunks with line-by-line changes locally.
 * This avoids asking Claude to return every line, saving significant tokens.
 */
import { DiffLine, DiffHunk, DiffFile } from '../types';

export { DiffLine, DiffHunk, DiffFile };

/**
 * Parse a unified diff string into structured data.
 * Extracts files, hunks, and line-by-line changes from git diff output.
 * This allows us to get line content locally instead of asking Claude to return it.
 * @param diffText - The raw git diff output
 * @returns Array of parsed files with their hunks and lines
 */
export function parseDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diffText.split('\n');
  
  let currentFile: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Start of a new file: diff --git a/old b/new
    if (line.startsWith('diff --git')) {
      // Save previous file/hunk
      if (currentHunk && currentFile) {
        currentFile.hunks.push(currentHunk);
      }
      if (currentFile) {
        files.push(currentFile);
      }
      
      // Parse file paths from diff --git line
      // Format: diff --git a/path/to/old b/path/to/new
      const match = line.match(/diff --git a\/(.+?) b\/(.+)$/);
      if (match) {
        const [, oldPath, newPath] = match;
        currentFile = {
          path: newPath,
          oldPath: oldPath === newPath ? undefined : oldPath,
          hunks: []
        };
      } else {
        currentFile = { path: '', hunks: [] };
      }
      currentHunk = null;
      continue;
    }
    
    // Skip header lines (index, ---, +++, etc.)
    if (line.startsWith('index ') || 
        line.startsWith('--- ') || 
        line.startsWith('+++ ') ||
        line.startsWith('new file') ||
        line.startsWith('deleted file') ||
        line.startsWith('similarity') ||
        line.startsWith('rename')) {
      continue;
    }
    
    // Hunk header: @@ -oldStart,oldLines +newStart,newLines @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && currentFile) {
      // Save previous hunk
      if (currentHunk) {
        currentFile.hunks.push(currentHunk);
      }
      
      const oldStart = parseInt(hunkMatch[1], 10);
      const oldLines = parseInt(hunkMatch[2] || '1', 10);
      const newStart = parseInt(hunkMatch[3], 10);
      const newLines = parseInt(hunkMatch[4] || '1', 10);
      
      currentHunk = {
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: []
      };
      continue;
    }
    
    // Diff content lines
    if (currentHunk) {
      if (line.startsWith('+')) {
        currentHunk.lines.push({
          type: 'add',
          content: line.slice(1)  // Remove leading +
        });
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({
          type: 'del',
          content: line.slice(1)  // Remove leading -
        });
      } else if (line.startsWith(' ')) {
        currentHunk.lines.push({
          type: 'context',
          content: line.slice(1)  // Remove leading space
        });
      } else if (line === '\\ No newline at end of file') {
        // Skip "no newline" markers
        continue;
      }
    }
  }
  
  // Don't forget the last hunk/file
  if (currentHunk && currentFile) {
    currentFile.hunks.push(currentHunk);
  }
  if (currentFile) {
    files.push(currentFile);
  }
  
  return files;
}

/**
 * Get a specific hunk from parsed diff by file path and position.
 * Used to match AI-returned hunk metadata with locally parsed line content.
 * @param parsedFiles - Array of parsed diff files
 * @param filePath - Path to the file to find
 * @param oldStart - Starting line number in old file
 * @param newStart - Starting line number in new file
 * @returns The matching hunk or null if not found
 */
export function findHunk(
  parsedFiles: DiffFile[],
  filePath: string,
  oldStart: number,
  newStart: number
): DiffHunk | null {
  const file = parsedFiles.find(f => f.path === filePath);
  if (!file) return null;
  
  return file.hunks.find(h => 
    h.oldStart === oldStart && h.newStart === newStart
  ) || null;
}

/**
 * Get all hunks for a specific file.
 * @param parsedFiles - Array of parsed diff files
 * @param filePath - Path to the file
 * @returns Array of hunks for the file, or empty array if not found
 */
export function getFileHunks(
  parsedFiles: DiffFile[],
  filePath: string
): DiffHunk[] {
  const file = parsedFiles.find(f => f.path === filePath);
  return file?.hunks || [];
}
