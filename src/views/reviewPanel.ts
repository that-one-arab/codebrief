import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { canHighlight, reloadTheme, TokenizedLineHtml, tokenizeDiff } from '../utils/highlighter';
import { stageAllChanges } from '../services/gitService';
import { logger } from '../utils';
import { GroupMetadata, GroupContent } from '../types';
import { reviewStore } from './reviewStore';
import { transformGroupContent, escapeHtmlForJson } from './reviewPanelTransforms';
import { buildReviewHtml } from './reviewPanelHtml';

export class ReviewPanel {
  public static currentPanel: ReviewPanel | undefined;
  private static readonly viewType = 'aiCodeReview';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _reviewTitle: string = 'Codebrief';
  private _groups: Map<string, GroupContent> = new Map();
  private _isWebviewReady: boolean = false;
  private _messageQueue: any[] = [];
  private _disposed: boolean = false;
  private _changesAuthoredByAi: boolean | null = null;
  private _storeListeners: Array<{ event: string; fn: (...args: any[]) => void }> = [];
  private _suggestedCommitMessage: string | undefined;

  /**
   * Open the panel in loading state while generating group structure.
   */
  public static createOrShowLoading(extensionUri: vscode.Uri): ReviewPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (ReviewPanel.currentPanel) {
      ReviewPanel.currentPanel._panel.reveal(column);
      ReviewPanel.currentPanel._setLoadingState();
      return ReviewPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      ReviewPanel.viewType,
      'Codebrief',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'images', 'icon.svg');

    ReviewPanel.currentPanel = new ReviewPanel(panel, extensionUri);
    ReviewPanel.currentPanel._setLoadingHtml();
    ReviewPanel.currentPanel._subscribeToStore();
    ReviewPanel.currentPanel._replayFromStore();
    return ReviewPanel.currentPanel;
  }

  /**
   * Show static review data (legacy/non-streaming mode).
   * Now reads from the store rather than accepting data directly.
   */
  public static createOrShowWithData(extensionUri: vscode.Uri, _reviewData?: any) {
    const reviewData = reviewStore.getCurrentReviewData();
    if (!reviewData) {
      vscode.window.showErrorMessage('Codebrief: No review data available');
      return;
    }

    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (ReviewPanel.currentPanel) {
      ReviewPanel.currentPanel._panel.reveal(column);
      // Replay from store to refresh content
      ReviewPanel.currentPanel._replayFromStore();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      ReviewPanel.viewType,
      'AI Analysis',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'images', 'icon.svg');

    ReviewPanel.currentPanel = new ReviewPanel(panel, extensionUri);
    ReviewPanel.currentPanel._setLoadingHtml();
    ReviewPanel.currentPanel._subscribeToStore();
    ReviewPanel.currentPanel._replayFromStore();
  }

  /**
   * Open or reveal the panel and scroll to a specific file.
   * Used when clicking a file in the TreeView.
   */
  public static createOrShowAndFocusFile(extensionUri: vscode.Uri, filePath: string) {
    const reviewData = reviewStore.getCurrentReviewData();
    if (!reviewData) {
      vscode.window.showErrorMessage('Codebrief: No review data available');
      return;
    }

    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (ReviewPanel.currentPanel) {
      ReviewPanel.currentPanel._panel.reveal(column);
      ReviewPanel.currentPanel._postMessage({
        command: 'focusFile',
        filePath
      });
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      ReviewPanel.viewType,
      'AI Analysis',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'images', 'icon.svg');

    ReviewPanel.currentPanel = new ReviewPanel(panel, extensionUri);
    ReviewPanel.currentPanel._pendingFileFocus = filePath;
    ReviewPanel.currentPanel._setLoadingHtml();
    ReviewPanel.currentPanel._subscribeToStore();
    ReviewPanel.currentPanel._replayFromStore();
  }

  private _pendingFileFocus: string | null = null;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Re-highlight all groups when the user switches color themes
    this._disposables.push(
      vscode.window.onDidChangeActiveColorTheme(() => this._handleThemeChange())
    );

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'webviewReady':
            this._isWebviewReady = true;
            this._flushMessageQueue();
            return;
          case 'openFile':
            try {
              const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
              if (!workspaceRoot) {
                throw new Error('No workspace folder open');
              }
              
              // Resolve relative paths against workspace root
              const resolvedPath = path.resolve(workspaceRoot, message.path);
              
              const doc = await vscode.workspace.openTextDocument(
                vscode.Uri.file(resolvedPath)
              );
              await vscode.window.showTextDocument(doc, {
                selection: new vscode.Range(message.line, 0, message.line, 0)
              });
            } catch (err) {
              vscode.window.showErrorMessage(`Failed to open file: ${message.path}`);
            }
            return;
          case 'loadContext':
            await this._handleLoadContext(message);
            return;
          case 'commitAll': {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) return;

            // Stage all changes via git CLI
            const stageResult = stageAllChanges(workspaceRoot);
            if (!stageResult.ok) {
              logger.error('reviewPanel', 'Failed to stage changes', { error: stageResult.error });
              vscode.window.showErrorMessage(`Failed to stage changes: ${stageResult.error}`);
              return;
            }
            logger.info('reviewPanel', 'All changes staged successfully');

            // Set the commit message in the Git SCM input box
            try {
              const gitExtension = vscode.extensions.getExtension('vscode.git');
              if (gitExtension) {
                const gitApi = await gitExtension.activate();
                const api = gitApi.getAPI(1);
                const repo = api.repositories.find((r: any) => r.rootUri.fsPath === workspaceRoot);
                if (repo && this._suggestedCommitMessage) {
                  repo.inputBox.value = this._suggestedCommitMessage;
                }
              }
            } catch (e) {
              logger.warn('reviewPanel', 'Failed to set commit message', { error: String(e) });
            }

            // Open the Source Control view
            await vscode.commands.executeCommand('workbench.view.scm');
            
            this._postMessage({ command: 'commitSuccess' });
            return;
          }
          case 'closePanel':
            this.dispose();
            return;
          case 'retry':
            // Execute the generate review command
            await vscode.commands.executeCommand('codebrief.generateReview');
            return;
        }
      },
      null,
      this._disposables
    );
  }

  /**
   * Subscribe to store events so the panel updates as generation progresses.
   */
  private _subscribeToStore(): void {
    const onMetadata = (title: string, groups: GroupMetadata[]) => {
      if (this._disposed) return;
      this.initGroups(title, groups, reviewStore.changesAuthoredByAi ?? undefined);
    };

    const onGroup = async (groupId: string, content: GroupContent) => {
      if (this._disposed) return;
      await this._updateGroupFromStore(groupId, content);
    };

    const onCommitMessage = (message: string) => {
      if (this._disposed) return;
      this._suggestedCommitMessage = message;
      // Update the webview with the commit message
      this._postMessage({
        command: 'updateCommitMessage',
        message
      });
    };

    const onComplete = () => {
      if (this._disposed) return;
      this.complete();
    };

    const onError = (message: string, canRetry?: boolean) => {
      if (this._disposed) return;
      if (canRetry) {
        this.showErrorWithRetry(message);
      } else {
        this.showError(message);
      }
    };

    reviewStore.on('metadata', onMetadata);
    reviewStore.on('group', onGroup);
    reviewStore.on('commitMessage', onCommitMessage);
    reviewStore.on('complete', onComplete);
    reviewStore.on('error', onError);

    this._storeListeners.push(
      { event: 'metadata', fn: onMetadata },
      { event: 'group', fn: onGroup },
      { event: 'commitMessage', fn: onCommitMessage },
      { event: 'complete', fn: onComplete },
      { event: 'error', fn: onError }
    );
  }

  /**
   * Unsubscribe from all store events.
   */
  private _unsubscribeFromStore(): void {
    for (const { event, fn } of this._storeListeners) {
      reviewStore.removeListener(event, fn);
    }
    this._storeListeners = [];
  }

  /**
   * Replay accumulated state from the store.
   * Called when panel is (re)created mid- or post-generation.
   */
  private async _replayFromStore(): Promise<void> {
    const state = reviewStore.state;

    if (state === 'idle') return;

    // Replay metadata if available
    if (reviewStore.groupMetas.length > 0) {
      this._suggestedCommitMessage = reviewStore.suggestedCommitMessage ?? undefined;
      this.initGroups(reviewStore.title, reviewStore.groupMetas, reviewStore.changesAuthoredByAi ?? undefined);

      // Replay all accumulated groups
      for (const [groupId, content] of reviewStore.groups) {
        // Only replay groups that have actual content (not skeletons)
        if (content.explanation || (content.files && content.files.length > 0 && content.files.some(f => f.hunks?.length))) {
          if (this._disposed) return;
          await this._updateGroupFromStore(groupId, content);
        }
      }
    }

    // Replay terminal state
    if (state === 'complete') {
      this.complete();
    } else if (state === 'error' && reviewStore.errorMessage) {
      this.showError(reviewStore.errorMessage);
    }
  }

  /**
   * Transform and send a group update to the webview.
   */
  private async _updateGroupFromStore(groupId: string, content: GroupContent): Promise<void> {
    // Store locally for panel's own tracking
    this._groups.set(groupId, content);

    const transformed = await transformGroupContent(content);

    // Check disposed after async tokenization
    if (this._disposed) return;

    this._postMessage({
      command: 'updateGroup',
      groupId,
      group: transformed
    });
  }

  /**
   * Handle loadContext message: read file lines and tokenize them.
   */
  private async _handleLoadContext(message: {
    filePath: string;
    fromLine: number;
    toLine: number;
    oldLineStart: number;
    insertId: string;
  }) {
    try {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      const resolvedPath = path.resolve(workspaceRoot, message.filePath);
      if (!resolvedPath.startsWith(workspaceRoot)) {
        throw new Error('Path outside workspace');
      }

      const fileContent = fs.readFileSync(resolvedPath, 'utf-8');
      const allLines = fileContent.split('\n');

      // fromLine/toLine are 1-based
      const from = Math.max(1, message.fromLine);
      const to = Math.min(allLines.length, message.toLine);

      if (from > to) {
        this._postMessage({
          command: 'contextLoaded',
          insertId: message.insertId,
          tokenizedLines: [],
          fromLine: from,
          toLine: to,
          oldLineStart: message.oldLineStart,
          totalFileLines: allLines.length
        });
        return;
      }

      const lines = allLines.slice(from - 1, to).map(content => ({
        type: 'context' as const,
        content
      }));

      let tokenizedLines: TokenizedLineHtml[];
      if (canHighlight(message.filePath)) {
        try {
          tokenizedLines = await tokenizeDiff(message.filePath, lines);
        } catch (e) {
          tokenizedLines = lines.map(l => ({
            type: l.type,
            html: escapeHtmlForJson(l.content)
          }));
        }
      } else {
        tokenizedLines = lines.map(l => ({
          type: l.type,
          html: escapeHtmlForJson(l.content)
        }));
      }

      if (this._disposed) return;

      this._postMessage({
        command: 'contextLoaded',
        insertId: message.insertId,
        tokenizedLines,
        fromLine: from,
        toLine: to,
        oldLineStart: message.oldLineStart,
        totalFileLines: allLines.length
      });
    } catch (e) {
      logger.warn('reviewPanel', 'Failed to load context', { filePath: message.filePath, error: String(e) });
      if (this._disposed) return;
      this._postMessage({
        command: 'contextLoaded',
        insertId: message.insertId,
        tokenizedLines: [],
        fromLine: message.fromLine,
        toLine: message.toLine,
        oldLineStart: message.oldLineStart,
        totalFileLines: 0
      });
    }
  }

  /**
   * Handle theme change: reload theme and re-tokenize all groups.
   */
  private async _handleThemeChange(): Promise<void> {
    if (this._disposed) return;

    try {
      await reloadTheme();

      // Re-transform and re-send all groups with new theme colors
      for (const [groupId, content] of this._groups) {
        if (content.explanation || (content.files && content.files.length > 0)) {
          if (this._disposed) return;
          const transformed = await transformGroupContent(content);
          if (this._disposed) return;
          this._postMessage({
            command: 'updateGroup',
            groupId,
            group: transformed
          });
        }
      }
    } catch (e) {
      logger.error('reviewPanel', 'Theme change handling failed', { error: String(e) });
    }
  }

  /**
   * Set the initial HTML for streaming mode.
   */
  private _setLoadingHtml() {
    const webview = this._panel.webview;
    this._panel.webview.html = this._getHtmlForWebview(webview, null);
  }

  /**
   * Set the panel to loading state while generating groups.
   */
  private _setLoadingState() {
    this._postMessage({ command: 'setLoading', message: 'Analyzing changes...' });
  }

  /**
   * Initialize the review with title and group skeletons.
   */
  public initGroups(title: string, groups: GroupMetadata[], changesAuthoredByAi?: boolean) {
    this._reviewTitle = title;
    if (typeof changesAuthoredByAi === 'boolean') {
      this._changesAuthoredByAi = changesAuthoredByAi;
    }
    this._groups.clear();

    // Store skeleton groups
    groups.forEach((meta) => {
      this._groups.set(meta.id, { ...meta, explanation: '', files: [] });
    });

    this._panel.title = 'AI Analysis';
    this._postMessage({
      command: 'initGroups',
      title,
      groups: groups.map((g, index) => ({ ...g, index })),
      changesAuthoredByAi: this._changesAuthoredByAi ?? undefined,
      providerName: reviewStore.providerName,
      suggestedCommitMessage: this._suggestedCommitMessage
    });
  }

  /**
   * Update a group with full content as it streams in.
   * Returns true if group was found and updated, false otherwise.
   */
  public async updateGroup(groupId: string, content: GroupContent): Promise<boolean> {
    const existing = this._groups.get(groupId);
    if (!existing) {
      const available = Array.from(this._groups.keys()).join(', ');
      console.warn(`Group ${groupId} not found. Available: ${available}`);
      return false;
    }

    // Merge metadata with content
    const fullGroup: GroupContent = {
      ...existing,
      ...content,
      id: groupId
    };

    this._groups.set(groupId, fullGroup);

    const transformed = await transformGroupContent(fullGroup);

    if (this._disposed) return true;

    this._postMessage({
      command: 'updateGroup',
      groupId,
      group: transformed
    });
    return true;
  }

  /**
   * Mark all groups as complete.
   */
  public complete() {
    this._postMessage({ command: 'complete' });
  }

  /**
   * Show error in the panel.
   */
  public showError(message: string) {
    this._postMessage({ command: 'error', message });
  }

  /**
   * Show error with retry option in the panel.
   */
  public showErrorWithRetry(message: string) {
    this._postMessage({ command: 'error', message, canRetry: true });
  }

  private _postMessage(message: any) {
    if (this._disposed) return;
    if (this._isWebviewReady) {
      this._panel.webview.postMessage(message);
    } else {
      this._messageQueue.push(message);
    }
  }

  private _flushMessageQueue() {
    while (this._messageQueue.length > 0) {
      const message = this._messageQueue.shift();
      this._panel.webview.postMessage(message);
    }
    // If there's a pending file focus, send it now that webview is ready
    if (this._pendingFileFocus) {
      this._postMessage({
        command: 'focusFile',
        filePath: this._pendingFileFocus
      });
      this._pendingFileFocus = null;
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview, reviewData: any): string {
    return buildReviewHtml({
      extensionUri: this._extensionUri,
      webview,
      reviewData,
      changesAuthoredByAi: reviewStore.changesAuthoredByAi ?? undefined,
      suggestedCommitMessage: this._suggestedCommitMessage
    });
  }

  public dispose() {
    this._disposed = true;
    this._unsubscribeFromStore();
    ReviewPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }
}
