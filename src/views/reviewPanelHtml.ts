import * as vscode from 'vscode';

interface HtmlOptions {
  extensionUri: vscode.Uri;
  webview: vscode.Webview;
  reviewData: any;
  changesAuthoredByAi?: boolean;
  suggestedCommitMessage?: string;
}

export function buildReviewHtml(options: HtmlOptions): string {
  const { extensionUri, webview, reviewData, changesAuthoredByAi, suggestedCommitMessage } = options;

  const styleUris = [
    'media/css/base.css',
    'media/css/states.css',
    'media/css/header.css',
    'media/css/layout.css',
    'media/css/diff.css',
    'media/css/footer.css',
    'media/css/search.css'
  ].map((p) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...p.split('/'))));

  const scriptUris = [
    'media/js/state.js',
    'media/js/utils.js',
    'media/js/context.js',
    'media/js/render.js',
    'media/js/streaming.js',
    'media/js/navigation.js',
    'media/js/search.js',
    'media/js/main.js'
  ].map((p) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...p.split('/'))));

  const markedUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'marked.umd.js')
  );

  const nonce = getNonce();

  const fallbackReviewData = {
    title: 'Codebrief',
    groups: [],
    changesAuthoredByAi: changesAuthoredByAi ?? undefined
  };

  return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';">
        ${styleUris.map((uri) => `<link href="${uri}" rel="stylesheet">`).join('\n        ')}
        <title>${reviewData?.title || 'Codebrief'}</title>
      </head>
      <body>
        <div id="app"></div>
        <script nonce="${nonce}">
          window.reviewData = ${JSON.stringify(reviewData || fallbackReviewData)};
          window.isStreaming = true;
        </script>
        <script nonce="${nonce}" src="${markedUri}"></script>
        ${scriptUris.map((uri) => `<script nonce="${nonce}" src="${uri}"></script>`).join('\n        ')}
      </body>
      </html>`;
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
