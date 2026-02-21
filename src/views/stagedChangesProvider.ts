/**
 * Staged Changes Provider - TreeDataProvider for staged files.
 */
import * as vscode from 'vscode';
import { FileChange } from './treeItems';
import * as groupMapping from './groupMapping';
import * as staging from './stagingState';

export class StagedChangesProvider implements vscode.TreeDataProvider<FileChange> {
  private _onDidChangeTreeData = new vscode.EventEmitter<FileChange | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  getTreeItem(element: FileChange): vscode.TreeItem {
    return element;
  }

  getChildren(): Thenable<FileChange[]> {
    staging.syncFromGit();
    const result: FileChange[] = [];
    
    for (const filePath of staging.getAllStaged()) {
      const groups = groupMapping.getGroupsForFile(filePath);
      if (groups.length === 0) continue;
      
      const file = groups[0].files.find(f => f.path === filePath);
      if (!file) continue;
      
      result.push(new FileChange(
        filePath.split('/').pop()!,
        filePath,
        file.lines,
        file.additions,
        file.deletions,
        groups,
        file.hunks
      ));
    }
    
    return Promise.resolve(result);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  clear(): void {
    staging.clearAll();
    this._onDidChangeTreeData.fire(undefined);
  }

  getStagedCount(): number {
    return staging.getStagedCount();
  }
}
