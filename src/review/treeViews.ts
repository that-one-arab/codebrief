import * as vscode from 'vscode';
import { IntentReviewProvider, StagedChangesProvider } from '../views';

export function registerTreeViews(
  context: vscode.ExtensionContext,
  intentProvider: IntentReviewProvider,
  stagedProvider: StagedChangesProvider
): void {
  const intentTreeView = vscode.window.createTreeView('aiIntentReview', {
    treeDataProvider: intentProvider,
    showCollapseAll: true
  });

  const stagedTreeView = vscode.window.createTreeView('aiStagedChanges', {
    treeDataProvider: stagedProvider
  });

  context.subscriptions.push(intentTreeView, stagedTreeView);
}
