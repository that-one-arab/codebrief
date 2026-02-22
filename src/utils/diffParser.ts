/**
 * Lightweight git diff parser - extracts hunks with line-by-line changes locally.
 * This avoids asking Claude to return every line, saving significant tokens.
 */
import { DiffLine, DiffHunk, DiffFile } from '../types';

export { DiffLine, DiffHunk, DiffFile };

interface DiffPaths {
  oldPath: string;
  newPath: string;
}

function unquoteGitPath(input: string): string {
  if (input.startsWith('"') && input.endsWith('"')) {
    try {
      return JSON.parse(input);
    } catch {
      const inner = input.slice(1, -1);
      return inner
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\r/g, '\r')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
  }
  if (input.includes('\\t') || input.includes('\\n') || input.includes('\\r') || input.includes('\\"')) {
    return input
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return input;
}

function normalizeDiffPath(rawPath: string): string {
  const unquoted = unquoteGitPath(rawPath);
  if (unquoted === '/dev/null' || unquoted === 'dev/null') {
    return '';
  }
  if (unquoted.startsWith('a/') || unquoted.startsWith('b/')) {
    return unquoted.slice(2);
  }
  return unquoted;
}

function splitDiffTokens(raw: string): [string, string] | null {
  let i = 0;
  const readToken = (): string | null => {
    if (i >= raw.length) return null;
    if (raw[i] === '"') {
      let j = i + 1;
      let token = '"';
      while (j < raw.length) {
        const ch = raw[j];
        token += ch;
        if (ch === '"' && raw[j - 1] !== '\\') {
          i = j + 1;
          return token;
        }
        j++;
      }
      return null;
    }
    let j = i;
    while (j < raw.length && raw[j] !== ' ') {
      j++;
    }
    const token = raw.slice(i, j);
    i = j;
    return token;
  };

  const first = readToken();
  if (!first) return null;
  while (i < raw.length && raw[i] === ' ') i++;
  const second = readToken();
  if (!second) return null;
  return [first, second];
}

function parseDiffGitLine(line: string): DiffPaths | null {
  if (!line.startsWith('diff --git ')) return null;
  const rest = line.slice('diff --git '.length);
  const tokens = splitDiffTokens(rest);
  if (!tokens) return null;
  const [oldRaw, newRaw] = tokens;
  return {
    oldPath: normalizeDiffPath(oldRaw),
    newPath: normalizeDiffPath(newRaw)
  };
}

function parseHeaderPath(line: string): string | null {
  if (!(line.startsWith('--- ') || line.startsWith('+++ '))) return null;
  const rest = line.slice(4);
  const token = splitDiffTokens(rest)?.[0] || rest.split('\t')[0] || rest.split(' ')[0];
  if (!token) return null;
  return normalizeDiffPath(token);
}

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
      
      // Parse file paths from diff --git line (handles prefixes + quoted paths)
      const paths = parseDiffGitLine(line);
      if (paths) {
        const primaryPath = paths.newPath || paths.oldPath;
        currentFile = {
          path: primaryPath,
          oldPath: paths.oldPath && paths.oldPath !== primaryPath ? paths.oldPath : undefined,
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
        line.startsWith('new file') ||
        line.startsWith('deleted file') ||
        line.startsWith('similarity') ||
        line.startsWith('rename')) {
      continue;
    }

    if ((line.startsWith('--- ') || line.startsWith('+++ ')) && currentFile && !currentFile.path) {
      const headerPath = parseHeaderPath(line);
      if (headerPath) {
        currentFile.path = headerPath;
      }
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
