/**
 * Staging state management - reflects git index truth.
 * Maintains a cached snapshot synced from git.
 */

import { getStagedFiles, getChangedFiles } from '../services';

let workspaceRoot: string | null = null;
const stagedFiles = new Set<string>();
const changedFiles = new Set<string>();

export function setWorkspaceRoot(root: string): void {
  workspaceRoot = root;
  syncFromGit();
}

export function syncFromGit(): void {
  stagedFiles.clear();
  changedFiles.clear();

  if (!workspaceRoot) return;

  for (const file of getStagedFiles(workspaceRoot)) {
    stagedFiles.add(file);
  }

  for (const file of getChangedFiles(workspaceRoot)) {
    changedFiles.add(file);
  }
}

export function isStaged(filePath: string): boolean {
  return stagedFiles.has(filePath);
}

export function stage(_filePath?: string): void {
  syncFromGit();
}

export function unstage(_filePath?: string): void {
  syncFromGit();
}

export function getAllStaged(): string[] {
  return Array.from(stagedFiles);
}

export function clearAll(): void {
  stagedFiles.clear();
  changedFiles.clear();
}

export function setStagedFiles(_files?: string[]): void {
  syncFromGit();
}

export function getStagedCount(): number {
  return stagedFiles.size;
}

export function setTotalFilesCount(_count?: number): void {
  syncFromGit();
}

export function getTotalFilesCount(): number {
  return changedFiles.size;
}

export function areAllFilesStaged(): boolean {
  return changedFiles.size > 0 && stagedFiles.size === changedFiles.size;
}
