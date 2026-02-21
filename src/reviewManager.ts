import * as vscode from 'vscode';
import { logger, generationController, ReviewIncompleteError } from './utils';
import { generateReview } from './reviewGenerator';
import { getProvider, changeProvider } from './providers';
import { IntentReviewProvider, StagedChangesProvider } from './views';
import { reviewStore } from './views';
import {
  stageFile,
  unstageFile,
  commitChanges,
  getGitDir,
  stageAllChanges,
  unstageAllChanges,
  getGitContext,
  isGitRepository
} from './services';
import { ReviewPanel } from './views';
import { registerTreeViews } from './review/treeViews';
import { registerUriHandler } from './review/uriHandler';
import { registerGitSync } from './review/gitSync';
import { registerCommands } from './review/commands';

export class ReviewManager {
  private intentProvider: IntentReviewProvider;
  private stagedProvider: StagedChangesProvider;
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.intentProvider = new IntentReviewProvider();
    this.stagedProvider = new StagedChangesProvider();
  }

  register(): void {
    registerTreeViews(this.context, this.intentProvider, this.stagedProvider);
    registerUriHandler(this.context, (workspace) => this.handleGenerateFromUri(workspace));
    registerCommands(this.context, {
      handleGenerateReview: () => this.handleGenerateReview(),
      handleRegenerate: () => this.handleRegenerate(),
      handleRefresh: () => this.handleRefresh(),
      handleAcceptGroup: (item) => this.handleAcceptGroup(item),
      handleRejectGroup: (item) => this.handleRejectGroup(item),
      handleAcceptAll: () => this.handleAcceptAll(),
      handleShowExplanation: (item) => this.handleShowExplanation(item),
      handleOpenFile: (filePath) => this.handleOpenFile(filePath),
      handleOpenInWebview: (filePath) => this.handleOpenInWebview(filePath),
      handleOpenDetailedView: () => this.handleOpenDetailedView(),
      handleStageGroup: (item) => this.handleStageGroup(item),
      handleUnstageGroup: (item) => this.handleUnstageGroup(item),
      handleStageFile: (item) => this.handleStageFile(item),
      handleUnstageFile: (item) => this.handleUnstageFile(item),
      handleStageAll: () => this.handleStageAll(),
      handleUnstageAll: () => this.handleUnstageAll(),
      handleCommit: () => this.handleCommit(),
      changeProvider: async () => { await changeProvider(this.context); },
      handleResetConfig: () => this.handleResetConfig()
    });
    this.registerGitSync();

    // Initially show the "Generate Review" welcome message
    vscode.commands.executeCommand('setContext', 'aiCodeReview:noReviewGenerated', true);

    // Listen for staleness changes
    reviewStore.on('stale', (staleFiles: Set<string>) => {
      this.intentProvider.setStaleFiles(staleFiles);
    });
  }

  private registerGitSync(): void {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) return;

    registerGitSync({
      context: this.context,
      workspaceRoot,
      intentProvider: this.intentProvider,
      stagedProvider: this.stagedProvider,
      getGitDir
    });
  }

  private async handleGenerateFromUri(workspace: string): Promise<void> {
    if (!this.canStartReview(workspace)) return;

    // Check if there's already a generation in progress
    if (generationController.hasActiveGeneration) {
      vscode.window.showInformationMessage('Cancelling previous review and starting new one...');
    }

    const provider = await getProvider(this.context);
    this.intentProvider.setWorkspaceRoot(workspace);
    // Open panel first so it subscribes to store events
    ReviewPanel.createOrShowLoading(this.context.extensionUri);
    await this.runGenerationWithRetry(workspace, provider);
  }


  private async runGenerationWithRetry(
    workspaceRoot: string,
    provider: import('./providers').ReviewProvider,
    maxRetries: number = 1
  ): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await generateReview(workspaceRoot, provider, this.intentProvider);
        return;
      } catch (error) {
        if (error instanceof ReviewIncompleteError && attempt < maxRetries) {
          logger.warn('reviewManager', 'Review incomplete, retrying', {
            reason: error.reason,
            attempt: attempt + 1,
            maxRetries
          });
          continue;
        }
        throw error;
      }
    }
  }

  // === Command Handlers ===

  private async handleGenerateReview(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('Codebrief: No workspace folder open');
      return;
    }

    if (!this.canStartReview(workspaceFolder.uri.fsPath)) return;

    // Check if there's already a generation in progress
    if (generationController.hasActiveGeneration) {
      vscode.window.showInformationMessage('Cancelling previous review and starting new one...');
    }

    // Resolve provider first (may show Quick Pick) before any UI changes
    const provider = await getProvider(this.context);

    this.intentProvider.setWorkspaceRoot(workspaceFolder.uri.fsPath);

    // Hide the welcome message and show skeletons while generating
    vscode.commands.executeCommand('setContext', 'aiCodeReview:noReviewGenerated', false);
    this.intentProvider.setLoading(true);

    // Open panel first so it subscribes to store events before generation starts
    ReviewPanel.createOrShowLoading(this.context.extensionUri);

    try {
      await this.runGenerationWithRetry(workspaceFolder.uri.fsPath, provider);
    } catch (error) {
      // If generation failed, show the welcome message again
      vscode.commands.executeCommand('setContext', 'aiCodeReview:noReviewGenerated', true);
      throw error;
    } finally {
      this.intentProvider.setLoading(false);
    }
  }

  private async handleRegenerate(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('Codebrief: No workspace folder open');
      return;
    }

    if (!this.canStartReview(workspaceFolder.uri.fsPath)) return;

    // Check if there's already a generation in progress
    if (generationController.hasActiveGeneration) {
      vscode.window.showInformationMessage('Cancelling previous review and regenerating...');
    }

    // Resolve provider first (may show Quick Pick) before any UI changes
    const provider = await getProvider(this.context);

    // Hide the welcome message and show skeletons while regenerating
    vscode.commands.executeCommand('setContext', 'aiCodeReview:noReviewGenerated', false);
    this.intentProvider.setLoading(true);

    // Open panel first so it subscribes to store events
    ReviewPanel.createOrShowLoading(this.context.extensionUri);

    try {
      await this.runGenerationWithRetry(workspaceFolder.uri.fsPath, provider);
    } catch (error) {
      vscode.commands.executeCommand('setContext', 'aiCodeReview:noReviewGenerated', true);
      throw error;
    } finally {
      this.intentProvider.setLoading(false);
    }
  }

  private handleRefresh(): void {
    this.intentProvider.refresh();
    this.stagedProvider.refresh();
    vscode.window.showInformationMessage('AI Review: Views refreshed');
  }

  private handleAcceptGroup(item: any): void {
    this.intentProvider.setStatus(item, 'accepted');
    vscode.window.showInformationMessage(`Accepted: ${item.label}`);
  }

  private handleRejectGroup(item: any): void {
    this.intentProvider.setStatus(item, 'rejected');
    vscode.window.showInformationMessage(`Rejected: ${item.label}`);
  }

  private handleAcceptAll(): void {
    this.intentProvider.acceptAll();
    vscode.window.showInformationMessage('All groups accepted');
  }

  private handleShowExplanation(item: any): void {
    this.intentProvider.showExplanation(item);
  }

  private handleOpenFile(filePath: string): void {
    const uri = vscode.Uri.file(filePath);
    vscode.workspace.openTextDocument(uri).then(
      doc => vscode.window.showTextDocument(doc),
      () => vscode.window.showWarningMessage(`Could not open file: ${filePath}`)
    );
  }

  private handleOpenInWebview(filePath: string): void {
    if (reviewStore.state === 'idle') {
      vscode.window.showWarningMessage('No review data available. Generate a review first.');
      return;
    }
    ReviewPanel.createOrShowAndFocusFile(this.context.extensionUri, filePath);
  }

  private handleOpenDetailedView(): void {
    if (reviewStore.state === 'idle') {
      vscode.window.showWarningMessage('No review data available. Generate a review first.');
      return;
    }
    ReviewPanel.createOrShowWithData(this.context.extensionUri);
  }

  // === Staging Handlers ===

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private canStartReview(workspaceRoot: string): boolean {
    if (!isGitRepository(workspaceRoot)) {
      vscode.window.showErrorMessage('Codebrief: Not a git repository');
      return false;
    }

    const git = getGitContext(workspaceRoot);
    if (!git) return false;
    if (!git.diff || git.diff.trim().length === 0) {
      vscode.window.showWarningMessage('No changes to review. Make or stage changes, then try again.');
      return false;
    }
    const hasHunks = git.parsedDiff.some(file => file.hunks.length > 0);
    if (!hasHunks) {
      vscode.window.showWarningMessage('No changes to review. Make or stage changes, then try again.');
      return false;
    }
    return true;
  }

  private handleStageGroup(item: any): void {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) return;

    let stagedCount = 0;
    for (const file of item.files) {
      const result = stageFile(workspaceRoot, file.path);
      if (result.ok) {
        this.intentProvider.stageFile(file.path);
        stagedCount++;
      } else {
        vscode.window.showErrorMessage(result.error ?? 'Failed to stage file');
        break;
      }
    }

    this.stagedProvider.refresh();
  }

  private handleUnstageGroup(item: any): void {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) return;

    for (const file of item.files) {
      const result = unstageFile(workspaceRoot, file.path);
      if (result.ok) {
        this.intentProvider.unstageFile(file.path);
      } else {
        vscode.window.showErrorMessage(result.error ?? 'Failed to unstage file');
        break;
      }
    }

    this.stagedProvider.refresh();
  }

  private handleStageFile(item: any): void {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) return;

    const result = stageFile(workspaceRoot, item.filePath);
    if (result.ok) {
      this.intentProvider.stageFile(item.filePath);
      this.stagedProvider.refresh();
    } else {
      vscode.window.showErrorMessage(result.error ?? 'Failed to stage file');
    }
  }

  private handleUnstageFile(item: any): void {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) return;

    const result = unstageFile(workspaceRoot, item.filePath);
    if (result.ok) {
      this.intentProvider.unstageFile(item.filePath);
      this.stagedProvider.refresh();
    } else {
      vscode.window.showErrorMessage(result.error ?? 'Failed to unstage file');
    }
  }

  private handleStageAll(): void {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) return;

    const result = stageAllChanges(workspaceRoot);
    if (result.ok) {
      this.intentProvider.refresh();
      this.stagedProvider.refresh();
    } else {
      vscode.window.showErrorMessage(result.error ?? 'Failed to stage all changes');
    }
  }

  private handleUnstageAll(): void {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) return;

    const result = unstageAllChanges(workspaceRoot);
    if (result.ok) {
      this.intentProvider.refresh();
      this.stagedProvider.refresh();
    } else {
      vscode.window.showErrorMessage(result.error ?? 'Failed to unstage all changes');
    }
  }

  private async handleCommit(): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) return;

    const stagedCount = this.stagedProvider.getStagedCount();
    if (stagedCount === 0) {
      vscode.window.showWarningMessage('No staged changes to commit');
      return;
    }

    const stagedFiles = this.intentProvider.getStagedFiles();
    const uniqueGroups = new Set(stagedFiles.flatMap(f =>
      f.parentGroups.map((g: any) => g.label.replace(/^[🔧⚡🐛⚠️🧪]\s*/, ''))
    ));

    const defaultMessage = uniqueGroups.size === 1
      ? Array.from(uniqueGroups)[0]
      : `${Array.from(uniqueGroups)[0]} +${uniqueGroups.size - 1} more`;

    const message = await vscode.window.showInputBox({
      value: defaultMessage,
      prompt: 'Commit message',
      placeHolder: 'Enter commit message...'
    });

    if (message && commitChanges(workspaceRoot, message)) {
      vscode.window.showInformationMessage(`Committed: ${message}`);
      this.stagedProvider.clear();
      this.intentProvider.clear();
      vscode.commands.executeCommand('setContext', 'aiCodeReview:noReviewGenerated', true);
    }
  }

  private async handleResetConfig(): Promise<void> {
    const config = vscode.workspace.getConfiguration('aiCodeReview');
    
    const result = await vscode.window.showWarningMessage(
      'Reset Codebrief configuration to defaults? This will also clear the selected AI provider.',
      { modal: true },
      'Reset'
    );
    
    if (result !== 'Reset') {
      return;
    }

    try {
      // Reset all configuration settings to their defaults
      await config.update('logLevel', undefined, true);
      await config.update('enableFileLogging', undefined, true);
      await config.update('preserveAnalysisJson', undefined, true);
      await config.update('logDirectory', undefined, true);

      // Clear the selected provider from global state
      await this.context.globalState.update('codebrief.provider', undefined);

      vscode.window.showInformationMessage('Codebrief configuration and provider selection reset');
      logger.info('reviewManager', 'Configuration and provider reset to defaults');
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to reset configuration: ${error.message}`);
      logger.error('reviewManager', 'Failed to reset configuration', { error: error.message });
    }
  }
}
