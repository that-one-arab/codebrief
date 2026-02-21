import * as vscode from 'vscode';
import { logger } from '../utils/logger';

export function registerUriHandler(
  context: vscode.ExtensionContext,
  onGenerateFromUri: (workspace: string) => Promise<void>
): void {
  const uriHandler: vscode.UriHandler = {
    handleUri: async (uri: vscode.Uri) => {
      logger.info('uriHandler', 'Received URI', { uri: uri.toString(), path: uri.path });

      if (uri.path === '/generate') {
        const params = new URLSearchParams(uri.query);
        const workspace = params.get('workspace');

        if (workspace) {
          logger.info('uriHandler', 'Processing generate request', { workspace });
          await onGenerateFromUri(workspace);
        } else {
          logger.error('uriHandler', 'Missing workspace parameter', { query: uri.query });
          vscode.window.showErrorMessage('Codebrief: Missing workspace parameter');
        }
      } else {
        logger.warn('uriHandler', 'Unknown command', { path: uri.path });
        vscode.window.showWarningMessage(`Codebrief: Unknown command ${uri.path}`);
      }
    }
  };

  context.subscriptions.push(
    vscode.window.registerUriHandler(uriHandler)
  );
}
