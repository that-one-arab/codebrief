/**
 * AI Review Providers.
 */

export type { ReviewProvider } from './provider';
export { ClaudeCodeProvider } from './claudeCode';
export { OpenCodeProvider } from './opencode';
export { CodexProvider } from './codex';

import * as vscode from 'vscode';
import { execFileSync } from 'child_process';
import { ReviewProvider } from './provider';
import { ClaudeCodeProvider } from './claudeCode';
import { OpenCodeProvider } from './opencode';
import { CodexProvider } from './codex';
import { logger } from '../utils/logger';

const CACHE_KEY = 'codebrief.provider';

interface ProviderEntry {
  name: string;
  binary: string;
  description: string;
  create: () => ReviewProvider;
}

const PROVIDERS: Record<string, ProviderEntry> = {
  'claude-code': {
    name: 'Claude Code',
    binary: 'claude',
    description: 'Anthropic Claude Code CLI',
    create: () => new ClaudeCodeProvider(),
  },
  // Temporarily disabled
  // 'opencode': {
  //   name: 'OpenCode',
  //   binary: 'opencode',
  //   description: 'OpenCode CLI',
  //   create: () => new OpenCodeProvider(),
  // },
  'codex': {
    name: 'Codex',
    binary: 'codex',
    description: 'OpenAI Codex CLI',
    create: () => new CodexProvider(),
  },
};

function isBinaryInstalled(binary: string): boolean {
  try {
    execFileSync('which', [binary], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function detectInstalled(): string[] {
  return Object.entries(PROVIDERS)
    .filter(([, entry]) => isBinaryInstalled(entry.binary))
    .map(([id]) => id);
}

export async function getProvider(context: vscode.ExtensionContext): Promise<ReviewProvider> {
  // Check cached choice
  const cachedId = context.globalState.get<string>(CACHE_KEY);
  if (cachedId && PROVIDERS[cachedId]) {
    if (isBinaryInstalled(PROVIDERS[cachedId].binary)) {
      logger.info('providers', 'Using cached provider', { provider: PROVIDERS[cachedId].name });
      return PROVIDERS[cachedId].create();
    }
    // Binary no longer available — clear cache and re-detect
    logger.info('providers', 'Cached provider unavailable, re-detecting', { cachedId });
    await context.globalState.update(CACHE_KEY, undefined);
  }

  const installed = detectInstalled();

  if (installed.length === 0) {
    throw new Error(
      'No AI provider found. Install one of: claude (Claude Code), opencode (OpenCode), codex (Codex).'
    );
  }

  if (installed.length === 1) {
    const id = installed[0];
    logger.info('providers', 'Auto-selected provider', { provider: PROVIDERS[id].name, reason: 'only one installed' });
    await context.globalState.update(CACHE_KEY, id);
    return PROVIDERS[id].create();
  }

  // Multiple providers available — prompt user
  const items = installed.map(id => ({
    label: PROVIDERS[id].name,
    description: PROVIDERS[id].description,
    id,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select an AI provider for code review',
  });

  if (!picked) {
    throw new Error('No AI provider selected.');
  }

  logger.info('providers', 'User selected provider', { provider: picked.label });
  await context.globalState.update(CACHE_KEY, picked.id);
  return PROVIDERS[picked.id].create();
}

export async function changeProvider(context: vscode.ExtensionContext): Promise<ReviewProvider | undefined> {
  const currentId = context.globalState.get<string>(CACHE_KEY);
  const installed = detectInstalled();

  if (installed.length === 0) {
    throw new Error(
      'No AI provider found. Install one of: claude (Claude Code), opencode (OpenCode), codex (Codex).'
    );
  }

  const items = installed.map(id => ({
    label: PROVIDERS[id].name,
    description: PROVIDERS[id].description,
    id,
  }));

  const quickPick = vscode.window.createQuickPick();
  quickPick.items = items;
  quickPick.placeholder = 'Select an AI provider for code review';
  
  // Pre-select the current provider if it exists
  if (currentId && installed.includes(currentId)) {
    const currentItem = items.find(item => item.id === currentId);
    if (currentItem) {
      quickPick.activeItems = [currentItem];
    }
  }

  const picked = await new Promise<typeof items[0] | undefined>(resolve => {
    quickPick.onDidAccept(() => {
      resolve(quickPick.selectedItems[0] as typeof items[0]);
      quickPick.hide();
    });
    quickPick.onDidHide(() => {
      resolve(undefined);
    });
    quickPick.show();
  });

  if (!picked) {
    // User cancelled — return current provider if cached
    if (currentId && PROVIDERS[currentId] && isBinaryInstalled(PROVIDERS[currentId].binary)) {
      return PROVIDERS[currentId].create();
    }
    return undefined;
  }

  logger.info('providers', 'User changed provider', { provider: picked.label });
  await context.globalState.update(CACHE_KEY, picked.id);
  return PROVIDERS[picked.id].create();
}
