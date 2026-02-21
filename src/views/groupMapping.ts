/**
 * Group mapping - tracks which files belong to which groups.
 */
import { IntentGroup } from './treeItems';

const fileToGroups = new Map<string, IntentGroup[]>();

export function addFileToGroup(filePath: string, group: IntentGroup): void {
  if (!fileToGroups.has(filePath)) {
    fileToGroups.set(filePath, []);
  }
  fileToGroups.get(filePath)!.push(group);
}

export function getGroupsForFile(filePath: string): IntentGroup[] {
  return fileToGroups.get(filePath) || [];
}

export function clearMapping(): void {
  fileToGroups.clear();
}

export function getAllFilePaths(): string[] {
  return Array.from(fileToGroups.keys());
}
