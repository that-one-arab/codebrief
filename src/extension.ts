import * as vscode from 'vscode';
import { initLogger, logger, setLogLevel, openLogDirectory } from './utils';
import { ReviewManager } from './reviewManager';

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Codebrief');
  
  // Read user configuration
  const config = vscode.workspace.getConfiguration('aiCodeReview');
  const logLevel = config.get<string>('logLevel', 'info');
  const enableFileLogging = config.get<boolean>('enableFileLogging', true);
  const preserveAnalysisJson = config.get<boolean>('preserveAnalysisJson', true);
  const customLogDir = config.get<string>('logDirectory', '');
  
  initLogger(outputChannel, {
    minLevel: logLevel as any,
    enableConsole: true,
    enableSampling: true,
    sampleInterval: 10,
    enableFileLogging,
    preserveAnalysisJson,
    logDirectory: customLogDir || undefined
  });
  
  logger.info('extension', 'Codebrief extension activated', {
    logLevel,
    enableFileLogging,
    preserveAnalysisJson,
    logDirectory: customLogDir || '(default)',
    extensionVersion: context.extension.packageJSON.version
  });

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('aiCodeReview.logLevel')) {
        const newLevel = vscode.workspace.getConfiguration('aiCodeReview').get<string>('logLevel', 'info');
        setLogLevel(newLevel as any);
      }
    })
  );

  // Register command to open log directory
  context.subscriptions.push(
    vscode.commands.registerCommand('codebrief.openLogDirectory', () => {
      openLogDirectory();
    })
  );

  const reviewManager = new ReviewManager(context);
  reviewManager.register();
}

export function deactivate() {
  logger.info('extension', 'Codebrief extension deactivated');
}
