/**
 * Claude Code provider - implements ReviewProvider using Claude Code CLI
 * with file-based streaming and comprehensive logging.
 */
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { logger, startOperation, endOperation, sampleLog } from '../utils/logger';
import { StreamingGroupResult, StreamingMetadataResult, StreamingCommitMessageResult, GitContext } from '../types';
import { ReviewProvider } from './provider';
import { buildStreamingPrompt } from './streamingPrompt';
import { buildAgentDrivenPrompt, classifyFiles } from './agentDrivenPrompt';
import { pollOutputDir } from './polling';
import { CancellationToken, throwIfCancelled } from '../utils';

const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const GROUP_CHECK_INTERVAL_MS = 500;

export class ClaudeCodeProvider implements ReviewProvider {
  readonly id = 'claude-code';
  readonly name = 'Claude Code';

  async generateReview(
    git: GitContext,
    workspaceRoot: string,
    onGroup: (result: StreamingGroupResult) => void | Promise<void>,
    onMetadata: (result: StreamingMetadataResult) => void | Promise<void>,
    onCommitMessage: (result: StreamingCommitMessageResult) => void | Promise<void>,
    cancellationToken?: CancellationToken,
    isLargeDiff?: boolean,
  ): Promise<void> {
    const opId = startOperation('claudeCode', 'generateReview', {
      workspaceRoot,
      filesChanged: git.filesChanged.length,
      diffLength: git.diff.length
    });

    try {
      const outputDir = await logger.timeAsync(
        'claudeCode',
        'Create temp directory',
        async () => fs.mkdtemp(path.join(os.tmpdir(), 'ai-review-'))
      );

      logger.info('claudeCode', 'Temp directory created', { outputDir }, opId);

      const prompt = isLargeDiff
        ? buildAgentDrivenPrompt(git.recentCommits, outputDir, classifyFiles(git.status))
        : buildStreamingPrompt(git, outputDir);
      logger.debug('claudeCode', 'Prompt built', {
        promptLength: prompt.length,
        outputDir,
        isLargeDiff: !!isLargeDiff
      }, opId);

      const allowedTools = isLargeDiff
        ? ["Write", "Bash", "Read"]
        : ["Write"];

      await callClaudeStreaming(prompt, workspaceRoot, outputDir, onGroup, onMetadata, onCommitMessage, opId, cancellationToken, allowedTools);

      // Check if cancelled before marking success
      if (cancellationToken?.isCancelled) {
        endOperation(opId, 'cancelled', { outputDir });
        return;
      }

      endOperation(opId, 'success', { outputDir });
    } catch (error: any) {
      logger.error('claudeCode', 'Generation failed', {
        error: error.message,
        stack: error.stack
      }, opId);
      endOperation(opId, 'error', { error: error.message });
      throw error;
    }
  }
}

// =============================================================================
// CLI INTERNALS
// =============================================================================

interface ClaudeSpawnOptions {
  args: string[];
  workspaceRoot: string;
}

function callClaudeStreaming(
  prompt: string,
  workspaceRoot: string,
  outputDir: string,
  onGroup: (result: StreamingGroupResult) => void | Promise<void>,
  onMetadata: (result: StreamingMetadataResult) => void | Promise<void>,
  onCommitMessage: (result: StreamingCommitMessageResult) => void | Promise<void>,
  parentOpId: string,
  cancellationToken?: CancellationToken,
  allowedTools: string[] = ["Write"]
): Promise<void> {
  const callStart = Date.now();
  
  logger.info('claudeCode', 'Spawning Claude process', {
    workspaceRoot,
    outputDir,
    timeoutMs: CLAUDE_TIMEOUT_MS
  }, parentOpId);

  const args = [
    '--continue',
    '--fork-session',
    '-p', prompt,
    '--no-session-persistence',
    "--allowedTools", allowedTools.join(',')
  ];

  logger.debug('claudeCode', 'Claude CLI arguments', { args: args.join(' ') }, parentOpId);

  return spawnClaude({ args, workspaceRoot }, callStart, (claude, resolve, reject, timeoutId, cleanup) => {
    let stderr = '';
    let isResolved = false;

    // Handle cancellation
    const onCancel = () => {
      logger.info('claudeCode', 'Cancelling Claude process', { pid: claude.pid }, parentOpId);
      try {
        claude.kill('SIGTERM');
      } catch (e) {
        logger.warn('claudeCode', 'Error killing Claude process', { error: String(e) }, parentOpId);
      }
    };

    cancellationToken?.onCancel(onCancel);

    const poller = pollOutputDir({
      outputDir,
      intervalMs: GROUP_CHECK_INTERVAL_MS,
      component: 'claudeCode',
      operationId: parentOpId,
      onGroup,
      onMetadata,
      onCommitMessage,
      cancellationToken
    });

    cleanup?.(() => {
      void poller.stop();
    });

    claude.stderr?.on('data', (data) => {
      const str = data.toString();
      stderr += str;
      const trimmed = str.trim();
      if (trimmed) {
        // Sample stderr to avoid noise from progress indicators
        sampleLog('debug', 'claudeCode', 'stderr', `stderr: ${trimmed.slice(0, 100)}`, undefined, 10);
      }
    });

    claude.on('close', async (code) => {
      await poller.stop();

      const elapsed = ((Date.now() - callStart) / 1000).toFixed(1);
      
      // Check if this was a cancellation
      if (cancellationToken?.isCancelled) {
        logger.info('claudeCode', 'Claude process closed after cancellation', {
          exitCode: code,
          elapsedSec: elapsed
        }, parentOpId);
        if (!isResolved) {
          isResolved = true;
          resolve(); // Resolve cleanly on cancellation
        }
        return;
      }
      
      if (code !== 0) {
        logger.error('claudeCode', 'Claude process exited with error', {
          exitCode: code,
          elapsedSec: elapsed,
          stderr: stderr.slice(0, 500)
        }, parentOpId);
      } else {
        logger.info('claudeCode', 'Claude process completed', {
          exitCode: code,
          elapsedSec: elapsed
        }, parentOpId);
      }

      if (isResolved) return;
      isResolved = true;

      if (code !== 0) {
        reject(new Error(`Claude exited with code ${code}: ${stderr}`));
      } else {
        resolve();
      }
    });

    claude.on('error', async (err) => {
      await poller.stop();

      logger.error('claudeCode', 'Claude process error', {
        error: err.message,
        isEnoent: err.message.includes('ENOENT')
      }, parentOpId);

      if (isResolved) return;
      isResolved = true;

      if (err.message.includes('ENOENT')) {
        reject(new Error('Claude CLI not found. Please install Claude Code.'));
      } else {
        reject(err);
      }
    });
  });
}

function spawnClaude<T>(
  options: ClaudeSpawnOptions,
  callStart: number,
  handler: (
    claude: ReturnType<typeof spawn>,
    resolve: (value: T) => void,
    reject: (error: Error) => void,
    timeoutId: NodeJS.Timeout,
    registerCleanup?: (cleanup: () => void) => void
  ) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    logger.debug('claudeCode', `Command: claude ${options.args.join(' ').slice(0, 100)}...`);

    const claude = spawn('claude', options.args, {
      cwd: options.workspaceRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    claude.stdin.end();
    logger.debug('claudeCode', 'stdin ended');

    const timeoutId = setTimeout(() => {
      logger.error('claudeCode', 'Process timed out', { timeoutMs: CLAUDE_TIMEOUT_MS });
      claude.kill('SIGTERM');
      reject(new Error('Claude process timed out'));
    }, CLAUDE_TIMEOUT_MS);

    const cleanupHandlers: Array<() => void> = [];

    handler(
      claude,
      resolve as any,
      reject,
      timeoutId,
      (cleanup) => cleanupHandlers.push(cleanup)
    );

    claude.on('error', (err) => {
      clearTimeout(timeoutId);
      cleanupHandlers.forEach(c => c());
      
      logger.error('claudeCode', 'Spawn error', {
        error: err.message,
        isEnoent: err.message.includes('ENOENT')
      });

      if (err.message.includes('ENOENT')) {
        reject(new Error('Claude CLI not found. Please install Claude Code.'));
      } else {
        reject(err);
      }
    });
  });
}
