import * as vscode from 'vscode';

interface CommandHandlers {
  handleGenerateReview: () => Promise<void> | void;
  handleRegenerate: () => Promise<void> | void;
  handleRefresh: () => void;
  handleAcceptGroup: (item: any) => void;
  handleRejectGroup: (item: any) => void;
  handleAcceptAll: () => void;
  handleShowExplanation: (item: any) => void;
  handleOpenFile: (filePath: string) => void;
  handleOpenInWebview: (filePath: string) => void;
  handleOpenDetailedView: () => void;
  handleStageGroup: (item: any) => void;
  handleUnstageGroup: (item: any) => void;
  handleStageFile: (item: any) => void;
  handleUnstageFile: (item: any) => void;
  handleStageAll: () => void;
  handleUnstageAll: () => void;
  handleCommit: () => Promise<void> | void;
  changeProvider: () => Promise<void> | void;
  handleResetConfig: () => Promise<void> | void;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  handlers: CommandHandlers
): void {
  const commands = [
    vscode.commands.registerCommand('codebrief.generateReview', () => handlers.handleGenerateReview()),
    vscode.commands.registerCommand('aiIntentReview.regenerate', () => handlers.handleRegenerate()),
    vscode.commands.registerCommand('aiIntentReview.refresh', () => handlers.handleRefresh()),

    vscode.commands.registerCommand('aiIntentReview.acceptGroup', (item) => handlers.handleAcceptGroup(item)),
    vscode.commands.registerCommand('aiIntentReview.rejectGroup', (item) => handlers.handleRejectGroup(item)),
    vscode.commands.registerCommand('aiIntentReview.acceptAll', () => handlers.handleAcceptAll()),
    vscode.commands.registerCommand('aiIntentReview.showExplanation', (item) => handlers.handleShowExplanation(item)),

    vscode.commands.registerCommand('aiIntentReview.openFile', (filePath) => handlers.handleOpenFile(filePath)),
    vscode.commands.registerCommand('aiIntentReview.openFileInWebview', (filePath) => handlers.handleOpenInWebview(filePath)),
    vscode.commands.registerCommand('aiIntentReview.openDetailedView', () => handlers.handleOpenDetailedView()),

    vscode.commands.registerCommand('aiIntentReview.stageGroup', (item) => handlers.handleStageGroup(item)),
    vscode.commands.registerCommand('aiIntentReview.unstageGroup', (item) => handlers.handleUnstageGroup(item)),
    vscode.commands.registerCommand('aiIntentReview.stageFile', (item) => handlers.handleStageFile(item)),
    vscode.commands.registerCommand('aiIntentReview.unstageFile', (item) => handlers.handleUnstageFile(item)),
    vscode.commands.registerCommand('aiIntentReview.stageAll', () => handlers.handleStageAll()),
    vscode.commands.registerCommand('aiIntentReview.unstageAll', () => handlers.handleUnstageAll()),
    vscode.commands.registerCommand('aiIntentReview.commit', () => handlers.handleCommit()),

    vscode.commands.registerCommand('aiIntentReview.changeProvider', () => handlers.changeProvider()),
    vscode.commands.registerCommand('codebrief.resetConfig', () => handlers.handleResetConfig())
  ];

  context.subscriptions.push(...commands);
}
