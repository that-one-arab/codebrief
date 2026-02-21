/**
 * Intent Review Provider - TreeDataProvider for groups.
 */
import * as vscode from 'vscode';
import { IntentGroup, FileChange, SkeletonItem, StaleReviewItem } from './treeItems';
import { IntentGroupFile } from '../types';
import { IntentGroupData, Status } from '../types';
import * as groupMapping from './groupMapping';
import * as staging from './stagingState';

type TreeItem = IntentGroup | FileChange | SkeletonItem | StaleReviewItem;

export class IntentReviewProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private groups: Map<string, IntentGroup> = new Map();
  private workspaceRoot: string = '';
  private isLoading: boolean = false;
  private _staleFiles: Set<string> = new Set();

  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
    staging.setWorkspaceRoot(root);
  }

  setLoading(loading: boolean): void {
    this.isLoading = loading;
    this._onDidChangeTreeData.fire();
  }

  setStaleFiles(files: Set<string>): void {
    this._staleFiles = files;
    // Update stale state on each group
    for (const group of this.groups.values()) {
      group.staleFiles = files;
      group.refresh();
    }
    this._onDidChangeTreeData.fire();
  }

  /**
   * Initialize groups from metadata (before content loads).
   * Shows group titles with loading state.
   */
  initGroupsFromMetadata(groups: { id: string; title: string }[]): void {
    this.isLoading = false;
    this.groups.clear();
    this._staleFiles.clear();
    groupMapping.clearMapping();
    this.syncStagedFiles();
    this.updateAllFilesStagedContext();

    for (const group of groups) {
      const intentGroup = new IntentGroup(
        group.id,
        group.title,
        '',  // explanation will come later
        'pending',
        []   // files will come later
      );
      intentGroup.setLoading(true);
      this.groups.set(group.id, intentGroup);
    }
    
    this._onDidChangeTreeData.fire();
  }

  /**
   * Update a group's files when content arrives.
   */
  updateGroupFiles(groupId: string, files: IntentGroupFile[], explanation: string): void {
    const group = this.groups.get(groupId);
    if (!group) {
      return;
    }

    group.explanation = explanation;
    group.setLoading(false);
    group.updateFiles(files);
    
    // Update group mapping for the new files
    for (const file of files) {
      groupMapping.addFileToGroup(file.path, group);
    }
    
    this._onDidChangeTreeData.fire(group);
  }

  loadReviewData(reviewData: { groups: IntentGroupData[] }): void {
    this.isLoading = false;
    this.groups.clear();
    groupMapping.clearMapping();
    this.syncStagedFiles();
    this.updateAllFilesStagedContext();

    for (const group of reviewData.groups) {
      const intentGroup = new IntentGroup(
        group.id,
        group.title,
        group.explanation,
        'pending',
        group.files
      );
      this.groups.set(group.id, intentGroup);
      
      for (const file of group.files) {
        groupMapping.addFileToGroup(file.path, intentGroup);
      }
    }
    
    this._onDidChangeTreeData.fire();
  }

  clear(): void {
    this.groups.clear();
    this._staleFiles.clear();
    groupMapping.clearMapping();
    staging.clearAll();
    this.updateAllFilesStagedContext();
    this._onDidChangeTreeData.fire();
  }

  refresh(): void {
    this.syncStagedFiles();
    this.updateAllFilesStagedContext();
    this._onDidChangeTreeData.fire();
  }

  setStatus(item: IntentGroup, status: Status): void {
    item.status = status;
    this._onDidChangeTreeData.fire(item);
  }

  acceptAll(): void {
    for (const group of this.groups.values()) {
      group.status = 'accepted';
    }
    this._onDidChangeTreeData.fire();
  }

  stageFile(filePath: string): FileChange | undefined {
    staging.stage(filePath);
    this.updateAllFilesStagedContext();
    
    const groups = groupMapping.getGroupsForFile(filePath);
    for (const group of groups) {
      group.refresh();
    }
    
    this._onDidChangeTreeData.fire(undefined);
    return this.createFileChange(filePath, groups);
  }

  unstageFile(filePath: string): void {
    staging.unstage(filePath);
    this.updateAllFilesStagedContext();
    
    const groups = groupMapping.getGroupsForFile(filePath);
    for (const group of groups) {
      group.refresh();
    }
    
    this._onDidChangeTreeData.fire(undefined);
  }

  getStagedFiles(): FileChange[] {
    return staging.getAllStaged()
      .map(filePath => {
        const groups = groupMapping.getGroupsForFile(filePath);
        return groups.length > 0 ? this.createFileChange(filePath, groups) : null;
      })
      .filter((f): f is FileChange => f !== null);
  }

  getAllFiles(): import('../types').IntentGroupFile[] {
    const allFiles = new Map<string, import('../types').IntentGroupFile>();
    for (const group of this.groups.values()) {
      for (const file of group.files) {
        allFiles.set(file.path, file);
      }
    }
    return Array.from(allFiles.values());
  }

  getGroupById(id: string): IntentGroup | undefined {
    return this.groups.get(id);
  }

  getAllGroups(): IntentGroup[] {
    return Array.from(this.groups.values());
  }

  showExplanation(item: IntentGroup): void {
    const panel = vscode.window.createWebviewPanel(
      'explanation',
      `Explanation: ${item.label}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );

    const stagedCount = item.files.filter(f => staging.isStaged(f.path)).length;
    const totalLines = item.files.reduce((sum, f) => sum + f.lines, 0);

    panel.webview.html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); }
          .header { margin-bottom: 20px; padding-bottom: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
          .explanation { line-height: 1.6; font-size: 14px; }
          .meta { margin-top: 20px; padding: 10px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 4px; }
          .staged { color: #89d185; }
        </style>
      </head>
      <body>
        <div class="header">
          <h2>${item.label}</h2>
        </div>
        <div class="explanation">
          ${item.explanation}
        </div>
        <div class="meta">
          <strong>Files affected:</strong> ${item.files.length}
          <br>
          <strong>Total lines:</strong> ${totalLines}
          ${stagedCount > 0 ? `<br><br><span class="staged">📦 ${stagedCount} file(s) staged</span>` : ''}
        </div>
      </body>
      </html>
    `;
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): Thenable<TreeItem[]> {
    if (!element) {
      // Show skeleton while loading
      if (this.isLoading) {
        return Promise.resolve([new SkeletonItem()]);
      }
      const items: TreeItem[] = Array.from(this.groups.values());
      if (this._staleFiles.size > 0) {
        items.push(new StaleReviewItem(this._staleFiles.size));
      }
      return Promise.resolve(items);
    }

    if (element instanceof IntentGroup) {
      const files = element.files.map(file => {
        const groups = groupMapping.getGroupsForFile(file.path);
        const fileChange = this.createFileChange(file.path, groups);
        fileChange.isStale = this._staleFiles.has(file.path);
        fileChange.refresh();
        return fileChange;
      });
      return Promise.resolve(files);
    }

    return Promise.resolve([]);
  }

  private updateAllFilesStagedContext(): void {
    vscode.commands.executeCommand('setContext', 'aiCodeReview:allFilesStaged', staging.areAllFilesStaged());
  }

  private syncStagedFiles(): void {
    if (!this.workspaceRoot) {
      staging.clearAll();
      return;
    }
    staging.syncFromGit();
  }

  private createFileChange(filePath: string, groups: IntentGroup[]): FileChange {
    const file = groups[0].files.find(f => f.path === filePath)!;
    return new FileChange(
      filePath.split('/').pop()!,
      filePath,
      file.lines,
      file.additions,
      file.deletions,
      groups,
      file.hunks
    );
  }
}
