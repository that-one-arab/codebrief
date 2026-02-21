/**
 * TreeItem classes for the AI Review tree views.
 */
import * as vscode from 'vscode';
import { Status, IntentGroupFile, DiffHunk } from '../types';
import * as staging from './stagingState';

export class IntentGroup extends vscode.TreeItem {
  public files: IntentGroupFile[];
  public isLoading: boolean = false;
  public staleFiles: Set<string> = new Set();

  constructor(
    public readonly id: string,
    public readonly label: string,
    public explanation: string,
    public status: Status,
    files: IntentGroupFile[] = [],
    public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Expanded
  ) {
    super(label, collapsibleState);
    this.files = files;
    this.refresh();
  }

  setLoading(loading: boolean): void {
    this.isLoading = loading;
    this.refresh();
  }

  updateFiles(files: IntentGroupFile[]): void {
    this.files = files;
    this.refresh();
  }

  private getContextValue(): string {
    const stagedCount = this.files.filter(f => staging.isStaged(f.path)).length;
    const totalCount = this.files.length;
    
    if (stagedCount === 0) return 'groupNoneStaged';
    if (stagedCount === totalCount) return 'groupAllStaged';
    return 'groupPartialStaged';
  }

  private getTooltip(): string {
    const stagedCount = this.files.filter(f => staging.isStaged(f.path)).length;
    const stagedInfo = stagedCount > 0 ? `✓ ${stagedCount}/${this.files.length} files staged\n\n` : '';
    return `${this.label}\n\n${stagedInfo}${this.explanation}`;
  }

  private getDescription(): string {
    if (this.isLoading) {
      return 'Loading...';
    }
    const totalLines = this.files.reduce((sum, f) => sum + f.lines, 0);
    const fileCount = this.files.length;
    const stagedCount = this.files.filter(f => staging.isStaged(f.path)).length;
    const hasStale = this.files.some(f => this.staleFiles.has(f.path));

    let desc: string;
    if (stagedCount === fileCount) {
      desc = `${fileCount} files, ${totalLines} lines • all staged`;
    } else if (stagedCount > 0) {
      desc = `${stagedCount}/${fileCount} files staged, ${totalLines} lines`;
    } else {
      desc = `${fileCount} files, ${totalLines} lines`;
    }
    return hasStale ? `${desc} • outdated` : desc;
  }

  refresh(): void {
    this.contextValue = this.getContextValue();
    this.tooltip = this.getTooltip();
    this.description = this.getDescription();
    
    if (this.isLoading) {
      this.iconPath = new vscode.ThemeIcon('sync~spin');
    } else {
      this.iconPath = undefined;
    }
  }
}

export class FileChange extends vscode.TreeItem {
  public isStale: boolean = false;

  constructor(
    public readonly label: string,
    public readonly filePath: string,
    public readonly lines: number,
    public readonly additions: number,
    public readonly deletions: number,
    public readonly parentGroups: IntentGroup[],
    public readonly hunks?: DiffHunk[]
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.refresh();

    this.resourceUri = vscode.Uri.file(filePath);
    this.command = {
      command: 'aiIntentReview.openFileInWebview',
      title: 'Open File in Review',
      arguments: [filePath]
    };
  }

  refresh(): void {
    const isStaged = staging.isStaged(this.filePath);
    this.contextValue = isStaged ? 'stagedFile' : 'unstagedFile';

    if (this.isStale) {
      this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    } else if (isStaged) {
      this.iconPath = new vscode.ThemeIcon('file', new vscode.ThemeColor('descriptionForeground'));
    } else {
      this.iconPath = undefined;
    }
  }
}

/**
 * A button shown in the AI Reviews panel when no review has been generated yet.
 */
export class GenerateButtonItem extends vscode.TreeItem {
  constructor() {
    super('Generate Review', vscode.TreeItemCollapsibleState.None);
    
    this.iconPath = new vscode.ThemeIcon('sparkle');
    this.contextValue = 'generateButton';
    this.tooltip = 'Click to generate a review for your staged changes';
    this.command = {
      command: 'codebrief.generateReview',
      title: 'Generate Review'
    };
  }
}

/**
 * Item shown when the review is stale (files changed since review).
 */
export class StaleReviewItem extends vscode.TreeItem {
  constructor(staleCount: number) {
    super('Review is outdated', vscode.TreeItemCollapsibleState.None);

    this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    this.description = `${staleCount} file(s) changed since review`;
    this.contextValue = 'staleReview';
    this.tooltip = 'Some reviewed files have been modified. Click to re-generate the review.';
    this.command = {
      command: 'codebrief.generateReview',
      title: 'Re-generate Review'
    };
  }
}

/**
 * Skeleton loading item shown while the review is being generated.
 */
export class SkeletonItem extends vscode.TreeItem {
  constructor() {
    super('Analyzing changes...', vscode.TreeItemCollapsibleState.None);
    
    this.iconPath = new vscode.ThemeIcon('sync~spin');
    this.contextValue = 'skeleton';
    this.description = ' ';
  }
}
