import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { IntentReviewProvider, StagedChangesProvider, reviewStore } from '../views';

interface GitExtensionApi {
  getAPI(version: 1): {
    repositories: Array<{
      rootUri: vscode.Uri;
      state: { onDidChange: vscode.Event<void> };
    }>;
    onDidOpenRepository?: vscode.Event<{ rootUri: vscode.Uri; state: { onDidChange: vscode.Event<void> } }>;
    onDidCloseRepository?: vscode.Event<{ rootUri: vscode.Uri }>;
  };
}

interface GitSyncOptions {
  context: vscode.ExtensionContext;
  workspaceRoot: string;
  intentProvider: IntentReviewProvider;
  stagedProvider: StagedChangesProvider;
  getGitDir: (workspaceRoot: string) => string | null;
}

export function registerGitSync(options: GitSyncOptions): void {
  const { context, workspaceRoot, intentProvider, stagedProvider, getGitDir } = options;

  intentProvider.setWorkspaceRoot(workspaceRoot);
  logger.debug('gitSync', 'Registered git sync', { workspaceRoot });

  let gitRepoDisposable: vscode.Disposable | null = null;
  let gitIndexWatcher: vscode.FileSystemWatcher | null = null;
  let gitSyncTimer: NodeJS.Timeout | null = null;

  const triggerSync = () => {
    if (gitSyncTimer) {
      clearTimeout(gitSyncTimer);
    }
    gitSyncTimer = setTimeout(() => {
      logger.debug('gitSync', 'Triggering providers refresh');
      intentProvider.refresh();
      stagedProvider.refresh();

      if (reviewStore.state === 'complete') {
        reviewStore.updateStaleness(workspaceRoot);
      }
    }, 200);
  };

  const gitExtension = vscode.extensions.getExtension('vscode.git');
  const attachGitApi = (exports: unknown) => {
    const apiProvider = exports as GitExtensionApi | undefined;
    if (!apiProvider || typeof apiProvider.getAPI !== 'function') {
      logger.warn('gitSync', 'Git extension API not available');
      return;
    }
    
    const api = apiProvider.getAPI(1);

    const attachRepoListener = (repo: { rootUri: vscode.Uri; state: { onDidChange: vscode.Event<void> } }) => {
      if (repo.rootUri.fsPath !== workspaceRoot) return;
      gitRepoDisposable?.dispose();
      gitRepoDisposable = repo.state.onDidChange(() => triggerSync());
      context.subscriptions.push(gitRepoDisposable);
      logger.debug('gitSync', 'Attached git repo listener', { workspaceRoot });
    };

    const repo = api.repositories.find(r => r.rootUri.fsPath === workspaceRoot);
    if (repo) {
      attachRepoListener(repo);
      return;
    }

    if (api.onDidOpenRepository) {
      context.subscriptions.push(api.onDidOpenRepository(attachRepoListener));
    }

    if (api.onDidCloseRepository) {
      context.subscriptions.push(api.onDidCloseRepository((closed) => {
        if (closed.rootUri.fsPath !== workspaceRoot) return;
        gitRepoDisposable?.dispose();
        gitRepoDisposable = null;
        logger.debug('gitSync', 'Git repo closed, removed listener');
      }));
    }
  };

  if (gitExtension) {
    if (gitExtension.isActive) {
      try {
        attachGitApi(gitExtension.exports);
      } catch (e) {
        logger.warn('gitSync', 'Git extension exports unavailable', { error: String(e) });
      }
    } else {
      gitExtension.activate().then(
        (exports) => attachGitApi(exports),
        (err) => logger.error('gitSync', 'Git extension activation failed', { error: String(err) })
      );
    }
  } else {
    logger.warn('gitSync', 'Git extension not found');
  }

  const gitDir = getGitDir(workspaceRoot);
  if (!gitDir) {
    logger.warn('gitSync', 'Git directory not found', { workspaceRoot });
    return;
  }

  const indexPattern = new vscode.RelativePattern(gitDir, 'index');
  gitIndexWatcher = vscode.workspace.createFileSystemWatcher(indexPattern);
  gitIndexWatcher.onDidChange(() => triggerSync());
  gitIndexWatcher.onDidCreate(() => triggerSync());
  gitIndexWatcher.onDidDelete(() => triggerSync());
  context.subscriptions.push(gitIndexWatcher);
  
  logger.debug('gitSync', 'Git index watcher registered', { gitDir });
}
