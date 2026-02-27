/**
 * Codex provider - implements ReviewProvider using Codex app-server (JSON-RPC over stdio).
 * Uses file-based streaming: Codex writes JSON files to a temp dir; provider polls for them.
 */
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import * as readline from 'readline';
import { logger, startOperation, endOperation, sampleLog } from '../utils/logger';
import { StreamingGroupResult, StreamingMetadataResult, StreamingCommitMessageResult, GitContext } from '../types';
import { ReviewProvider } from './provider';
import { buildStreamingPrompt } from './streamingPrompt';
import { buildCommitMessagePrompt, buildGroupPrompt, buildGroupingPrompt } from './twoPassPrompts';
import { pollOutputDir } from './polling';
import { buildFileSummaries, buildHunkCoordinateIndex, renderGroupDiff, estimateTokens, GROUP_DIFF_TOKEN_THRESHOLD } from '../utils';
import { jsonrepair } from 'jsonrepair';

const APP_SERVER_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const GROUP_CHECK_INTERVAL_MS = 500;


// =============================================================================
// APP-SERVER CLIENT
// =============================================================================

type JsonRpcRequest = { id: number; method: string; params?: any };
type JsonRpcResponse = { id: number; result?: any; error?: { code: number; message: string } };
type JsonRpcNotification = { method: string; params?: any };

class AppServerClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams;
  private rl: readline.Interface;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(proc: ChildProcessWithoutNullStreams) {
    super();
    this.proc = proc;
    this.rl = readline.createInterface({ input: proc.stdout });

    this.rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        logger.warn('codex', 'Failed to parse JSONL', { line: line.slice(0, 200) });
        return;
      }

      if (typeof msg.id === 'number') {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        const response = msg as JsonRpcResponse;
        if (response.error) {
          pending.reject(new Error(response.error.message));
        } else {
          pending.resolve(response.result);
        }
        return;
      }

      if (msg.method) {
        this.emit('notification', msg as JsonRpcNotification);
      }
    });

    this.proc.on('error', (err) => {
      this.emit('error', err);
    });

    this.proc.on('exit', (code, signal) => {
      this.emit('exit', { code, signal });
    });
  }

  send(request: JsonRpcRequest): void {
    this.proc.stdin.write(`${JSON.stringify(request)}\n`);
  }

  async request(method: string, params?: any): Promise<any> {
    const id = this.nextId++;
    const request: JsonRpcRequest = { id, method, params };
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.send(request);
    return promise;
  }

  notify(method: string, params?: any): void {
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  close(): void {
    this.rl.close();
    this.proc.kill('SIGTERM');
  }
}

async function readMetadataFile(outputDir: string, opId?: string): Promise<any> {
  const metadataPath = path.join(outputDir, 'metadata.json');
  try {
    const content = await fs.readFile(metadataPath, 'utf-8');
    try {
      return JSON.parse(content);
    } catch {
      const repaired = jsonrepair(content);
      return JSON.parse(repaired);
    }
  } catch (error: any) {
    logger.error('codex', 'Failed to read metadata.json after grouping pass', {
      filePath: metadataPath,
      error: error.message
    }, opId);
    throw error;
  }
}

function workspaceHintFromThread(thread: any): string | null {
  return (
    normalizePath(thread?.cwd) ||
    normalizePath(thread?.directory) ||
    normalizePath(thread?.workspace) ||
    normalizePath(thread?.settings?.cwd) ||
    normalizePath(thread?.metadata?.cwd) ||
    normalizePath(thread?.metadata?.directory) ||
    normalizePath(thread?.metadata?.workspace) ||
    null
  );
}

function workspaceHintFromTurn(turn: any): string | null {
  return (
    normalizePath(turn?.cwd) ||
    normalizePath(turn?.settings?.cwd) ||
    normalizePath(turn?.environment?.cwd) ||
    normalizePath(turn?.sandboxPolicy?.cwd) ||
    null
  );
}

async function listThreads(client: AppServerClient, archived: boolean): Promise<any[]> {
  const result = await client.request('thread/list', {
    cursor: null,
    limit: 200,
    sortKey: 'created_at',
    archived: !!archived,
  });
  return result?.data || [];
}

async function findLatestThreadForWorkspace(
  client: AppServerClient,
  workspaceRoot: string,
  operationId?: string
): Promise<string | null> {
  const normalizedWorkspace = normalizePath(workspaceRoot);
  const threads = await listThreads(client, false);

  logger.debug('codex', 'Searching for workspace thread', { 
    workspaceRoot: normalizedWorkspace, 
    threadsToCheck: threads.length 
  }, operationId);

  for (const thread of threads) {
    const hint = workspaceHintFromThread(thread);
    if (hint && hint === normalizedWorkspace) {
      logger.info('codex', 'Found matching thread', { threadId: thread.id }, operationId);
      return thread.id || null;
    }
  }

  for (const thread of threads) {
    try {
      const res = await client.request('thread/read', {
        threadId: thread.id,
        includeTurns: true,
      });
      const turns = res?.thread?.turns || [];
      const hasWorkspace = turns.some((turn: any) => workspaceHintFromTurn(turn) === normalizedWorkspace);
      if (hasWorkspace) {
        logger.info('codex', 'Found thread via turn inspection', { threadId: thread.id }, operationId);
        return thread.id || null;
      }
    } catch (e) {
      logger.warn('codex', 'Failed to read thread while searching for workspace', {
        threadId: thread.id,
        error: (e as Error).message
      }, operationId);
    }
  }

  logger.info('codex', 'No existing thread found for workspace', undefined, operationId);
  return null;
}

async function startAppServer(operationId?: string): Promise<AppServerClient> {
  logger.info('codex', 'Starting app-server', undefined, operationId);
  
  const proc = spawn('codex', ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  proc.stderr.on('data', (data) => {
    const trimmed = data.toString().trim();
    if (trimmed) {
      sampleLog('debug', 'codex', 'stderr', 'App-server stderr', { msg: trimmed.slice(0, 100) }, 5);
    }
  });

  const client = new AppServerClient(proc);

  const timeout = setTimeout(() => {
    logger.error('codex', 'App-server initialization timeout', { timeoutMs: APP_SERVER_TIMEOUT_MS }, operationId);
    client.close();
  }, APP_SERVER_TIMEOUT_MS);

  try {
    let rejectInit: (err: Error) => void = () => {};
    const initGate = new Promise<void>((_, reject) => {
      rejectInit = reject;
    });

    const onError = (err: Error) => {
      rejectInit(err);
    };
    const onExit = ({ code, signal }: { code: number | null; signal: NodeJS.Signals | null }) => {
      rejectInit(new Error(`Codex app-server exited (code=${code}, signal=${signal})`));
    };

    client.once('error', onError);
    client.once('exit', onExit);

    await Promise.race([
      client.request('initialize', {
        clientInfo: { name: 'codebrief', title: 'Codebrief', version: '0.1.0' },
      }),
      initGate
    ]);

    client.off('error', onError);
    client.off('exit', onExit);

    client.notify('initialized', {});
    clearTimeout(timeout);
    
    logger.info('codex', 'App-server initialized', undefined, operationId);
    return client;
  } catch (e) {
    clearTimeout(timeout);
    client.close();
    throw e;
  }
}


// =============================================================================
// THREAD TRACKING
// =============================================================================

function normalizePath(value: string): string {
  if (!value) return value;
  if (value.length > 1 && value.endsWith(path.sep)) return value.slice(0, -1);
  return value;
}

// =============================================================================
// CODEX PROVIDER
// =============================================================================

export class CodexProvider implements ReviewProvider {
  readonly id = 'codex-app-server';
  readonly name = 'Codex';

  async generateReview(
    git: GitContext,
    workspaceRoot: string,
    onGroup: (result: StreamingGroupResult) => void | Promise<void>,
    onMetadata: (result: StreamingMetadataResult) => void | Promise<void>,
    onCommitMessage: (result: StreamingCommitMessageResult) => void | Promise<void>,
    cancellationToken?: import('../utils').CancellationToken,
    isLargeDiff?: boolean,
  ): Promise<void> {
    const normalizedWorkspace = normalizePath(workspaceRoot);
    const opId = startOperation('codex', 'generateReview', {
      workspaceRoot: normalizedWorkspace,
      filesChanged: git.filesChanged.length,
      diffLength: git.diff.length
    });

    let client: AppServerClient | undefined;
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-review-'));
    let baseThreadId: string | null = null;
    let runThreadId: string | null = null;
    let shouldArchiveRunThread = false;

    try {
      client = await startAppServer(opId);
      
      baseThreadId = await findLatestThreadForWorkspace(client, normalizedWorkspace, opId);

      if (!baseThreadId) {
        logger.info('codex', 'No base thread found, creating new base thread', undefined, opId);

        const result = await client.request('thread/start', {
          cwd: normalizedWorkspace,
          approvalPolicy: 'never',
          sandbox: 'workspace-write'
        });
        baseThreadId = result?.thread?.id || null;
        if (!baseThreadId) {
          throw new Error('Failed to create base thread');
        }
        runThreadId = baseThreadId;
        logger.info('codex', 'Using new base thread directly for this run', { runThreadId }, opId);
      } else {
        try {
          const forked = await client.request('thread/fork', { threadId: baseThreadId });
          runThreadId = forked?.thread?.id;
          shouldArchiveRunThread = true;
          logger.info('codex', 'Forked thread', { baseThreadId, runThreadId }, opId);
        } catch (e) {
          logger.warn('codex', 'Fork failed, using base thread directly', {
            baseThreadId,
            error: (e as Error).message
          }, opId);
          runThreadId = baseThreadId;
        }
      }

      if (!runThreadId) {
        throw new Error('Failed to acquire run thread');
      }

      await fs.mkdir(outputDir, { recursive: true });
      logger.info('codex', 'Temp directory created', { outputDir }, opId);

      const activeClient = client;
      if (!activeClient) {
        throw new Error('Codex client unavailable');
      }

      const turnCompleted = (expectedTurnId?: string) => new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Codex turn timed out after ${TURN_TIMEOUT_MS / 1000}s`));
        }, TURN_TIMEOUT_MS);

        const onNotification = (msg: JsonRpcNotification) => {
          if (msg.method === 'turn/completed') {
            clearTimeout(timeout);
            activeClient.off('notification', onNotification);
            const turn = msg.params?.turn;
            const status = turn?.status;
            const turnId = turn?.id;
            if (expectedTurnId && turnId && turnId !== expectedTurnId) return;
            if (status && status !== 'completed') {
              reject(new Error(`Codex turn ended with status: ${status}, details: ${JSON.stringify(turn).slice(0, 300)}`));
            } else {
              resolve();
            }
          }
          if (msg.method === 'turn/failed' || msg.method === 'error') {
            if (msg.method === 'turn/failed') {
              const turnId = msg.params?.turn?.id;
              if (expectedTurnId && turnId && turnId !== expectedTurnId) return;
            }
            logger.error('codex', 'Turn failed notification received', {
              method: msg.method,
              params: JSON.stringify(msg.params || {}).slice(0, 500)
            }, opId);
            clearTimeout(timeout);
            client!.off('notification', onNotification);
            const errorDetail = msg.params?.error?.message
              || msg.params?.reason
              || msg.params?.message
              || JSON.stringify(msg.params || {}).slice(0, 300);
            reject(new Error(`Codex turn failed: ${errorDetail}`));
          }
        };

        activeClient.on('notification', onNotification);
      });

      const runPrompt = async (prompt: string, startTimeMs?: number) => {
        logger.debug('codex', 'Prompt built', { promptLength: prompt.length, isLargeDiff: !!isLargeDiff }, opId);

        const poller = pollOutputDir({
          outputDir,
          intervalMs: GROUP_CHECK_INTERVAL_MS,
          component: 'codex',
          operationId: opId,
          onGroup,
          onMetadata,
          onCommitMessage,
          startTimeMs
        });

        const turn = await activeClient.request('turn/start', {
          threadId: runThreadId,
          input: [{ type: 'text', text: prompt }],
          cwd: normalizedWorkspace,
          approvalPolicy: 'never',
          sandboxPolicy: {
            type: 'workspaceWrite',
            writableRoots: [normalizedWorkspace, outputDir],
            networkAccess: false
          }
        });

        try {
          await turnCompleted(turn?.turn?.id);
          logger.info('codex', 'Turn completed successfully', undefined, opId);
        } finally {
          await poller.stop();
        }
      };

      if (!isLargeDiff) {
        const prompt = buildStreamingPrompt(git, outputDir);
        await runPrompt(prompt);
      } else {
        const fileSummaries = buildFileSummaries(git.parsedDiff, git.filesChanged);
        const groupingPrompt = buildGroupingPrompt(fileSummaries, git.recentCommits, outputDir);
        await runPrompt(groupingPrompt);

        const metadata = await readMetadataFile(outputDir, opId);
        const groups = Array.isArray(metadata?.groups) ? metadata.groups : [];
        const changesAuthoredByAi = !!metadata?.changesAuthoredByAi;

        for (let i = 0; i < groups.length; i++) {
          const group = groups[i];
          if (!group?.id || !group?.title) {
            throw new Error(`Invalid group metadata at index ${i}`);
          }
          const groupFiles = Array.isArray(group?.files) ? group.files : [];
          const groupDiffFiles = git.parsedDiff.filter(f => groupFiles.includes(f.path));
          const hunkMap = buildHunkCoordinateIndex(groupDiffFiles);

          const fullDiff = renderGroupDiff(groupDiffFiles, 'full');
          const isSummary = estimateTokens(fullDiff) > GROUP_DIFF_TOKEN_THRESHOLD;
          const diffText = isSummary ? renderGroupDiff(groupDiffFiles, 'summary') : fullDiff;

          const groupPrompt = buildGroupPrompt({
            groupIndex: i,
            groupId: group.id,
            title: group.title,
            changesAuthoredByAi,
            hunkMap,
            diffText,
            diffMode: isSummary ? 'summary' : 'full',
            outputDir
          });

          await runPrompt(groupPrompt, Date.now());
        }

        const commitPrompt = buildCommitMessagePrompt({
          title: metadata?.title || 'Codebrief',
          groups: groups.map((group: any) => ({
            id: group.id,
            title: group.title,
            files: Array.isArray(group.files) ? group.files : []
          })),
          recentCommits: git.recentCommits,
          outputDir
        });

        await runPrompt(commitPrompt, Date.now());
      }

      endOperation(opId, 'success', { runThreadId, outputDir });

    } catch (error: any) {
      logger.error('codex', 'Generation failed', {
        error: error.message,
        baseThreadId,
        runThreadId
      }, opId);
      endOperation(opId, 'error', { error: error.message });
      throw error;
    } finally {
      // Clean up: archive only forked run threads.
      // Base threads are kept for later reuse/forking.
      if (runThreadId && client && shouldArchiveRunThread) {
        try {
          await client.request('thread/archive', { threadId: runThreadId });
          logger.debug('codex', 'Archived run thread', { runThreadId }, opId);
        } catch (e) {
          logger.warn('codex', 'Failed to archive run thread', { runThreadId, error: (e as Error).message }, opId);
        }
      }

      // Clean up temp dir
      try {
        await fs.rm(outputDir, { recursive: true, force: true });
        logger.debug('codex', 'Temp directory cleaned up', { outputDir }, opId);
      } catch (e: any) {
        logger.warn('codex', 'Failed to clean up temp directory', { outputDir, error: e.message }, opId);
      }

      client?.close();
    }
  }
}
