/**
 * Git service - handles all git operations with enhanced logging.
 */
import { execSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { parseDiff } from '../utils/diffParser';
import { logger } from '../utils/logger';
import { GitContext, DiffFile } from '../types';

export interface GitOpResult {
  ok: boolean;
  error?: string;
}

/**
 * Gather git context from the workspace including diff, branch, commits, and files changed.
 * Also parses the diff locally to extract line-by-line changes.
 */
export function getGitContext(workspaceRoot: string): GitContext {
  logger.debug('gitService', 'Gathering git context', { workspaceRoot });

  const exec = (cmd: string, context?: string) => {
    try {
      const start = Date.now();
      const result = execSync(cmd, { cwd: workspaceRoot, encoding: 'utf-8' }).trim();
      logger.debug('gitService', `Git command executed${context ? `: ${context}` : ''}`, {
        command: cmd.slice(0, 50),
        durationMs: Date.now() - start
      });
      return result;
    } catch (error: any) {
      logger.debug('gitService', `Git command failed${context ? `: ${context}` : ''}`, {
        command: cmd.slice(0, 50),
        error: error.message
      });
      return '';
    }
  };

  const execDiff = (args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: workspaceRoot, encoding: 'utf-8' }).trim();
    } catch (error: any) {
      return (error?.stdout?.toString('utf-8') ?? '').trim();
    }
  };

  const startTime = Date.now();

  // Get tracked changes
  const trackedDiff = exec('git diff HEAD', 'tracked-diff');
  
  // Get untracked files and their diffs
  const untrackedFiles = exec('git ls-files --others --exclude-standard', 'untracked-files');
  const untrackedDiff = untrackedFiles
    ? untrackedFiles
        .split('\n')
        .map(file => execDiff(['diff', '--no-index', '--', '/dev/null', file]))
        .filter(Boolean)
        .join('\n')
    : '';
  
  const diff = [trackedDiff, untrackedDiff].filter(Boolean).join('\n');
  const filesChanged = extractFilesFromDiff(diff);
  
  // Parse diff locally for line-level info
  logger.debug('gitService', 'Parsing diff', { diffLength: diff.length });
  const parsedDiff = parseDiff(diff);
  
  const context: GitContext = {
    head: exec('git rev-parse --short HEAD', 'head'),
    branch: exec('git rev-parse --abbrev-ref HEAD', 'branch'),
    diff,
    status: exec('git status --short', 'status'),
    recentCommits: exec('git log --oneline -10', 'recent-commits'),
    filesChanged,
    parsedDiff,
  };

  const duration = Date.now() - startTime;
  logger.info('gitService', 'Git context gathered', {
    durationMs: duration,
    branch: context.branch,
    head: context.head,
    filesChanged: filesChanged.length,
    trackedDiffLength: trackedDiff.length,
    untrackedDiffLength: untrackedDiff.length,
    parsedFiles: parsedDiff.length,
    totalHunks: parsedDiff.reduce((sum, f) => sum + f.hunks.length, 0)
  });

  return context;
}

function extractFilesFromDiff(diff: string): string[] {
  return diff
    .split('\n')
    .filter(line => line.startsWith('diff --git'))
    .map(line => {
      const match = line.match(/b\/(.*)$/);
      return match ? match[1] : '';
    })
    .filter(Boolean);
}

/**
 * Verify that the given path is a git repository.
 */
export function isGitRepository(workspaceRoot: string): boolean {
  try {
    execSync('git rev-parse --git-dir', { cwd: workspaceRoot });
    logger.debug('gitService', 'Git repository verified', { workspaceRoot });
    return true;
  } catch (error: any) {
    logger.warn('gitService', 'Not a git repository', { 
      workspaceRoot,
      error: error.message 
    });
    return false;
  }
}

/**
 * Resolve the git directory for a workspace (handles worktrees/relative paths).
 */
export function getGitDir(workspaceRoot: string): string | null {
  try {
    const output = execSync('git rev-parse --git-dir', { cwd: workspaceRoot, encoding: 'utf-8' }).trim();
    if (!output) return null;
    const result = path.isAbsolute(output) ? output : path.join(workspaceRoot, output);
    logger.debug('gitService', 'Git directory resolved', { workspaceRoot, gitDir: result });
    return result;
  } catch (error: any) {
    logger.warn('gitService', 'Failed to resolve git directory', { 
      workspaceRoot,
      error: error.message 
    });
    return null;
  }
}

/**
 * Stage a file to git index.
 */
export function stageFile(workspaceRoot: string, filePath: string): GitOpResult {
  const relativePath = toRelativePath(workspaceRoot, filePath);
  
  try {
    const start = Date.now();
    execFileSync('git', ['add', relativePath], { cwd: workspaceRoot });
    
    logger.info('gitService', 'File staged', {
      file: relativePath,
      durationMs: Date.now() - start
    });
    return { ok: true };
  } catch (error) {
    const message = formatGitError('Failed to stage file', error);
    logger.error('gitService', 'Stage file failed', {
      file: relativePath,
      error: message
    });
    return { ok: false, error: message };
  }
}

/**
 * Unstage a file from git index.
 */
export function unstageFile(workspaceRoot: string, filePath: string): GitOpResult {
  const relativePath = toRelativePath(workspaceRoot, filePath);
  
  try {
    const start = Date.now();
    execFileSync('git', ['reset', 'HEAD', relativePath], { cwd: workspaceRoot });
    
    logger.info('gitService', 'File unstaged', {
      file: relativePath,
      durationMs: Date.now() - start
    });
    return { ok: true };
  } catch (error) {
    const message = formatGitError('Failed to unstage file', error);
    logger.error('gitService', 'Unstage file failed', {
      file: relativePath,
      error: message
    });
    return { ok: false, error: message };
  }
}

/**
 * Commit staged changes.
 */
export function commitChanges(workspaceRoot: string, message: string): boolean {
  try {
    const start = Date.now();
    execFileSync('git', ['commit', '-m', message], { cwd: workspaceRoot });
    
    logger.info('gitService', 'Changes committed', {
      message: message.slice(0, 50),
      durationMs: Date.now() - start
    });
    return true;
  } catch (error: any) {
    logger.error('gitService', 'Commit failed', {
      message: message.slice(0, 50),
      error: formatGitError('Failed to commit', error)
    });
    return false;
  }
}

/**
 * Get list of currently staged files.
 */
export function getStagedFiles(workspaceRoot: string): string[] {
  try {
    const output = execSync('git diff --cached --name-only', { cwd: workspaceRoot, encoding: 'utf-8' }).trim();
    const files = output ? output.split('\n') : [];
    logger.debug('gitService', 'Got staged files', { count: files.length });
    return files;
  } catch (error: any) {
    logger.warn('gitService', 'Failed to get staged files', { error: error.message });
    return [];
  }
}

/**
 * Get list of all changed files (staged, unstaged, untracked).
 */
export function getChangedFiles(workspaceRoot: string): string[] {
  try {
    const output = execFileSync('git', ['status', '--porcelain', '-z'], { cwd: workspaceRoot });
    const text = output.toString('utf-8');
    if (!text) return [];

    const entries = text.split('\0').filter(Boolean);
    const files: string[] = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const status = entry.slice(0, 2);
      const filePath = entry.slice(3);

      if (status[0] === 'R' || status[0] === 'C') {
        const newPath = entries[i + 1];
        if (newPath) {
          files.push(newPath);
          i++;
        } else if (filePath) {
          files.push(filePath);
        }
        continue;
      }

      if (filePath) {
        files.push(filePath);
      }
    }

    logger.debug('gitService', 'Got changed files', { count: files.length });
    return files;
  } catch (error: any) {
    logger.warn('gitService', 'Failed to get changed files', { error: error.message });
    return [];
  }
}

/**
 * Check if a file is staged.
 */
export function isFileStaged(workspaceRoot: string, filePath: string): boolean {
  const stagedFiles = getStagedFiles(workspaceRoot);
  const relativePath = toRelativePath(workspaceRoot, filePath);
  return stagedFiles.includes(relativePath);
}

/**
 * Check if a directory contains a .git entry (is a git repo root).
 */
function isNestedGitRepo(dirPath: string): boolean {
  try {
    return fs.existsSync(path.join(dirPath, '.git'));
  } catch {
    return false;
  }
}

/**
 * For a given untracked directory, expand it into individual files,
 * skipping any nested git repositories and their contents.
 * Returns file paths relative to workspaceRoot.
 */
function expandDirSkippingNestedRepos(workspaceRoot: string, relDir: string): string[] {
  const fullDir = path.join(workspaceRoot, relDir);
  const results: string[] = [];

  try {
    const entries = fs.readdirSync(fullDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryRelPath = path.join(relDir, entry.name);
      const entryFullPath = path.join(fullDir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === '.git' || isNestedGitRepo(entryFullPath)) {
          continue; // skip .git dirs and nested repos entirely
        }
        results.push(...expandDirSkippingNestedRepos(workspaceRoot, entryRelPath));
      } else {
        results.push(entryRelPath);
      }
    }
  } catch {
    // directory may not exist or be unreadable
  }

  return results;
}

/**
 * Stage all changes in the repository.
 * Mimics VS Code's "Stage All" by staging only files reported by git status,
 * filtering out nested git repositories and their contents.
 */
export function stageAllChanges(workspaceRoot: string): GitOpResult {
  try {
    const start = Date.now();
    const changedFiles = getChangedFiles(workspaceRoot);

    // For each entry, if it's a directory, expand it into individual files
    // while skipping nested git repos. Regular files pass through as-is.
    const files: string[] = [];
    for (const file of changedFiles) {
      const clean = file.replace(/\/$/, '');
      const fullPath = path.join(workspaceRoot, clean);

      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          if (isNestedGitRepo(fullPath)) {
            logger.debug('gitService', 'Skipping nested git repo', { path: clean });
            continue;
          }
          // Expand directory, skipping any nested repos inside
          const expanded = expandDirSkippingNestedRepos(workspaceRoot, clean);
          logger.debug('gitService', 'Expanded directory', { dir: clean, fileCount: expanded.length });
          files.push(...expanded);
          continue;
        }
      } catch {
        // stat failed — file may be deleted, still needs staging
      }

      files.push(clean);
    }

    if (files.length === 0) {
      logger.info('gitService', 'No changes to stage');
      return { ok: true };
    }

    // Stage in batches to avoid exceeding argument length limits
    const batchSize = 50;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      execFileSync('git', ['add', '--', ...batch], { cwd: workspaceRoot });
    }

    logger.info('gitService', 'All changes staged', {
      fileCount: files.length,
      durationMs: Date.now() - start
    });
    return { ok: true };
  } catch (error) {
    const message = formatGitError('Failed to stage all changes', error);
    logger.error('gitService', 'Stage all failed', { error: message });
    return { ok: false, error: message };
  }
}

/**
 * Unstage all changes in the repository.
 */
export function unstageAllChanges(workspaceRoot: string): GitOpResult {
  try {
    const start = Date.now();
    execFileSync('git', ['reset', 'HEAD', '--', '.'], { cwd: workspaceRoot });
    
    logger.info('gitService', 'All changes unstaged', {
      durationMs: Date.now() - start
    });
    return { ok: true };
  } catch (error) {
    const message = formatGitError('Failed to unstage all changes', error);
    logger.error('gitService', 'Unstage all failed', { error: message });
    return { ok: false, error: message };
  }
}

function toRelativePath(workspaceRoot: string, filePath: string): string {
  return filePath.startsWith(workspaceRoot) 
    ? filePath.slice(workspaceRoot.length + 1)
    : filePath;
}

function formatGitError(prefix: string, error: unknown): string {
  const err = error as { stderr?: Buffer; stdout?: Buffer; message?: string };
  const stderr = err?.stderr?.toString('utf-8')?.trim();
  const stdout = err?.stdout?.toString('utf-8')?.trim();
  const details = stderr || stdout || err?.message || 'Unknown git error';
  return `${prefix}: ${details}`;
}
