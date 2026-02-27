/**
 * OpenCode provider - implements ReviewProvider using the OpenCode HTTP server API.
 *
 * Uses file-writing approach: AI writes JSON files to a workspace-local temp dir,
 * provider polls for them (same pattern as Claude Code provider).
 */
import { spawn, ChildProcess, execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import detect from 'detect-port';
import { logger, startOperation, endOperation, sampleLog } from '../utils/logger';
import { StreamingGroupResult, StreamingMetadataResult, StreamingCommitMessageResult, GitContext } from '../types';
import { ReviewProvider } from './provider';
import { buildStreamingPrompt } from './streamingPrompt';
import { buildCommitMessagePrompt, buildGroupPrompt, buildGroupingPrompt } from './twoPassPrompts';
import { pollOutputDir } from './polling';
import { CancellationToken, buildFileSummaries, buildHunkCoordinateIndex, renderGroupDiff, estimateTokens, GROUP_DIFF_TOKEN_THRESHOLD } from '../utils';
import { jsonrepair } from 'jsonrepair';

const DEFAULT_PORT = 4096;
const PROBE_TIMEOUT_MS = 1000;
const SERVER_STARTUP_TIMEOUT_MS = 15_000;
const SERVER_POLL_INTERVAL_MS = 300;
const MESSAGE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const GROUP_CHECK_INTERVAL_MS = 500;
const DIAGNOSTIC_BUFFER_LIMIT = 200;

// Cache for opencode state directory path
let opencodeStateDir: string | null = null;

/**
 * Get the opencode state directory by running `opencode debug paths`.
 * This handles multi-user setups where the state dir may not be in the default XDG location.
 * Results are cached for the lifetime of the extension.
 */
async function getOpenCodeStateDir(operationId?: string): Promise<string> {
  // Return cached value if available
  if (opencodeStateDir) {
    return opencodeStateDir;
  }

  logger.debug('opencode', 'Querying opencode state directory via debug paths', undefined, operationId);

  return new Promise((resolve, reject) => {
    execFile('opencode', ['debug', 'paths'], { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        logger.error('opencode', 'Failed to run opencode debug paths', { error: error.message }, operationId);
        reject(new Error(`Failed to get opencode paths: ${error.message}`));
        return;
      }

      // Parse output to find state path
      // Output format:
      // home       /Users/your-name
      // data       /Users/your-name/.local/share/opencode
      // bin        /Users/your-name/.local/share/opencode/bin
      // log        /Users/your-name/.local/share/opencode/log
      // cache      /Users/your-name/.cache/opencode
      // config     /Users/your-name/.config/opencode
      // state      /Users/your-name/.local/state/opencode
      const lines = stdout.split('\n');
      for (const line of lines) {
        const match = line.match(/^state\s+(\S.+)$/);
        if (match) {
          opencodeStateDir = match[1].trim();
          logger.debug('opencode', 'Found opencode state directory', { stateDir: opencodeStateDir }, operationId);
          resolve(opencodeStateDir);
          return;
        }
      }

      logger.error('opencode', 'Could not parse state path from opencode debug paths output', { stdout }, operationId);
      reject(new Error('Could not determine opencode state directory from debug paths output'));
    });
  });
}


// =============================================================================
// SERVER DETECTION & MANAGEMENT
// =============================================================================

interface OpenCodeServer {
  port: number;
  process: ChildProcess | null;
  forkSession: boolean;
  diagnostics: ServerDiagnostics;
}

interface ServerDiagnostics {
  stdout: string[];
  stderr: string[];
}

function mapDiagnosticsToUserError(diagnostics?: ServerDiagnostics): string | null {
  if (!diagnostics?.stderr?.length) return null;
  const stderr = diagnostics.stderr.join('\n');

  if (stderr.includes('ProviderModelNotFoundError')) {
    const providerMatch = stderr.match(/providerID:\s*"([^"]+)"/);
    const modelMatch = stderr.match(/modelID:\s*"([^"]+)"/);
    const provider = providerMatch?.[1] ?? 'unknown';
    const model = modelMatch?.[1] ?? 'unknown';
    return `OpenCode model configuration error: provider "${provider}" cannot find model "${model}". Update your OpenCode provider/model selection and retry.`;
  }

  if (stderr.includes('ModelNotFoundError')) {
    return 'OpenCode model configuration error: selected model was not found. Update your OpenCode provider/model selection and retry.';
  }

  return null;
}

function pushDiagnosticLine(buffer: string[], line: string): void {
  buffer.push(line);
  if (buffer.length > DIAGNOSTIC_BUFFER_LIMIT) {
    buffer.splice(0, buffer.length - DIAGNOSTIC_BUFFER_LIMIT);
  }
}

function appendDiagnosticChunk(buffer: string[], chunk: string): void {
  const normalized = chunk.replace(/\r/g, '');
  for (const line of normalized.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) {
      pushDiagnosticLine(buffer, trimmed.slice(0, 500));
    }
  }
}

async function checkForSessions(port: number, workspaceRoot: string, operationId?: string): Promise<boolean> {
  logger.debug('opencode', 'Checking for sessions', { port, workspaceRoot }, operationId);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(`http://127.0.0.1:${port}/session`, { signal: controller.signal });
    clearTimeout(timeout);
    const sessions = await res.json() as any[];
    const matching = sessions.filter((s: any) => s.directory === workspaceRoot);
    
    logger.debug('opencode', 'Sessions query result', {
      totalSessions: sessions.length,
      matchingSessions: matching.length,
      sessionDirs: sessions.map((s: any) => s.directory)
    }, operationId);
    
    return matching.length > 0;
  } catch (e: any) {
    logger.warn('opencode', 'Session query failed', { error: e.name, message: e.message }, operationId);
    return false;
  }
}

async function waitForServer(port: number, operationId?: string): Promise<void> {
  const deadline = Date.now() + SERVER_STARTUP_TIMEOUT_MS;
  let attempts = 0;
  
  logger.info('opencode', 'Waiting for server', { port, timeoutMs: SERVER_STARTUP_TIMEOUT_MS }, operationId);

  while (Date.now() < deadline) {
    attempts++;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      await fetch(`http://127.0.0.1:${port}`, { signal: controller.signal });
      clearTimeout(timeout);
      
      const elapsed = Date.now() - (deadline - SERVER_STARTUP_TIMEOUT_MS);
      logger.info('opencode', 'Server ready', { attempts, elapsedMs: elapsed }, operationId);
      return;
    } catch {
      await new Promise(r => setTimeout(r, SERVER_POLL_INTERVAL_MS));
    }
  }

  logger.error('opencode', 'Server startup timeout', { attempts, timeoutMs: SERVER_STARTUP_TIMEOUT_MS }, operationId);
  throw new Error(`OpenCode server did not start within ${SERVER_STARTUP_TIMEOUT_MS / 1000}s`);
}

async function startOpenCodeServer(
  port: number,
  cwd: string,
  diagnostics: ServerDiagnostics,
  operationId?: string,
): Promise<ChildProcess> {
  logger.info('opencode', 'Spawning server', { port, cwd }, operationId);

  const proc = spawn('opencode', ['serve', '--port', String(port)], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  logger.info('opencode', 'Server spawned', { pid: proc.pid, port }, operationId);

  // Sample stdout/stderr to avoid noise
  proc.stdout?.on('data', (data) => {
    const trimmed = data.toString().trim();
    appendDiagnosticChunk(diagnostics.stdout, data.toString());
    if (trimmed) {
      sampleLog('debug', 'opencode', 'stdout', 'Server stdout', { msg: trimmed.slice(0, 100) }, 5);
    }
  });

  proc.stderr?.on('data', (data) => {
    const trimmed = data.toString().trim();
    appendDiagnosticChunk(diagnostics.stderr, data.toString());
    if (trimmed) {
      sampleLog('debug', 'opencode', 'stderr', 'Server stderr', { msg: trimmed.slice(0, 100) }, 5);
    }
  });

  proc.on('exit', (code, signal) => {
    logger.info('opencode', 'Server process exited', { code, signal }, operationId);
  });

  return proc;
}

async function acquireServer(workspaceRoot: string, operationId?: string): Promise<OpenCodeServer> {
  const port = await detect(DEFAULT_PORT);
  logger.debug('opencode', 'Port detected', { port, requested: DEFAULT_PORT }, operationId);

  const diagnostics: ServerDiagnostics = { stdout: [], stderr: [] };
  const proc = await startOpenCodeServer(port, workspaceRoot, diagnostics, operationId);

  proc.on('error', (err) => {
    if (err.message.includes('ENOENT')) {
      logger.error('opencode', 'OpenCode binary not found', undefined, operationId);
    } else {
      logger.error('opencode', 'Server process error', { error: err.message }, operationId);
    }
  });

  try {
    await waitForServer(port, operationId);
  } catch (e) {
    logger.error('opencode', 'Server startup failed, killing process', { pid: proc.pid }, operationId);
    proc.kill('SIGTERM');
    throw new Error('Failed to start opencode server. Is opencode installed?');
  }

  const forkSession = await checkForSessions(port, workspaceRoot, operationId);
  logger.info('opencode', 'Server acquired', { port, pid: proc.pid, forkSession }, operationId);

  return { port, process: proc, forkSession, diagnostics };
}

// =============================================================================
// SESSION MANAGEMENT
// =============================================================================

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function createSession(port: number, title: string, directory: string, operationId?: string): Promise<{ id: string }> {
  logger.info('opencode', 'Creating session', { title, directory }, operationId);
  
  const res = await fetch(`${baseUrl(port)}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, directory }),
  });
  
  if (!res.ok) {
    const body = await res.text();
    logger.error('opencode', 'Create session failed', { status: res.status, body: body.slice(0, 200) }, operationId);
    throw new Error(`Failed to create session: ${res.status} ${res.statusText}`);
  }
  
  const session = await res.json() as { id: string };
  logger.info('opencode', 'Session created', { sessionId: session.id }, operationId);
  return session;
}

async function forkLatestSession(port: number, workspaceRoot: string, operationId?: string): Promise<{ id: string }> {
  logger.info('opencode', 'Fetching sessions to fork', { workspaceRoot }, operationId);
  
  const res = await fetch(`${baseUrl(port)}/session`);
  if (!res.ok) {
    logger.error('opencode', 'List sessions failed', { status: res.status }, operationId);
    throw new Error(`Failed to list sessions: ${res.status}`);
  }
  
  const sessions = await res.json() as any[];
  const matching = sessions.filter((s: any) => s.directory === workspaceRoot);
  
  logger.debug('opencode', 'Sessions found', { total: sessions.length, matching: matching.length }, operationId);

  if (matching.length === 0) {
    throw new Error('No sessions for this workspace available to fork');
  }

  const original = matching[0];
  logger.info('opencode', 'Forking session', { originalId: original.id, title: original.title }, operationId);

  const forkRes = await fetch(`${baseUrl(port)}/session/${original.id}/fork`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  
  if (!forkRes.ok) {
    const body = await forkRes.text();
    logger.error('opencode', 'Fork failed', { status: forkRes.status, body: body.slice(0, 200) }, operationId);
    throw new Error(`Failed to fork session: ${forkRes.status}`);
  }
  
  const forked = await forkRes.json() as { id: string };
  logger.info('opencode', 'Session forked', { forkedId: forked.id, originalId: original.id }, operationId);
  return forked;
}

async function getRecentModel(operationId?: string): Promise<{ modelID: string; providerID: string }> {
  const stateDir = await getOpenCodeStateDir(operationId);
  const modelPath = path.join(stateDir, 'model.json');
  logger.debug('opencode', 'Reading model config', { modelPath }, operationId);
  
  const raw = await fs.readFile(modelPath, 'utf-8');
  const data = JSON.parse(raw) as { recent: { providerID: string; modelID: string }[] };
  
  if (!data.recent?.length) {
    throw new Error('No recent models found in model.json');
  }
  
  const model = data.recent[0];
  logger.debug('opencode', 'Model selected', { providerID: model.providerID, modelID: model.modelID }, operationId);
  return model;
}

/** Send a message and return the raw response body. */
async function sendMessage(
  port: number,
  sessionId: string,
  text: string,
  diagnostics?: ServerDiagnostics,
  operationId?: string,
  cancellationToken?: CancellationToken,
): Promise<any> {
  const promptPreview = text.slice(0, 100).replace(/\n/g, '\\n');
  
  logger.info('opencode', 'Sending message', { 
    sessionId, 
    promptLength: text.length, 
    preview: promptPreview + '...' 
  }, operationId);

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    logger.warn('opencode', 'Message timeout reached', { timeoutMs: MESSAGE_TIMEOUT_MS }, operationId);
    controller.abort();
  }, MESSAGE_TIMEOUT_MS);

  // Handle cancellation
  const onCancel = () => {
    logger.info('opencode', 'Cancelling message request', { sessionId }, operationId);
    controller.abort();
  };
  cancellationToken?.onCancel(onCancel);

  const sendStart = Date.now();

  try {
    const model = await getRecentModel(operationId);
    const res = await fetch(`${baseUrl(port)}/session/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        parts: [{ type: 'text', text }],
      }),
      signal: controller.signal,
    });

    const elapsed = Date.now() - sendStart;

    if (!res.ok) {
      const body = await res.text();
      const mappedError = mapDiagnosticsToUserError(diagnostics);
      logger.error('opencode', 'Message failed', { 
        elapsedMs: elapsed, 
        status: res.status, 
        body: body.slice(0, 200),
        serverStderrTail: diagnostics?.stderr.slice(-20),
        serverStdoutTail: diagnostics?.stdout.slice(-10),
        mappedError,
      }, operationId);
      if (mappedError) {
        throw new Error(mappedError);
      }
      throw new Error(`Message failed: ${res.status} ${res.statusText}`);
    }

    const rawBody = await res.text();
    if (!rawBody.trim()) {
      const mappedError = mapDiagnosticsToUserError(diagnostics);
      logger.info('opencode', 'Message completed with empty response body', {
        elapsedMs: elapsed,
        status: res.status,
        serverStderrTail: diagnostics?.stderr.slice(-20),
        serverStdoutTail: diagnostics?.stdout.slice(-10),
        mappedError,
      }, operationId);
      if (mappedError) {
        throw new Error(mappedError);
      }
      return null;
    }

    try {
      const data = JSON.parse(rawBody);
      logger.info('opencode', 'Message completed', { elapsedMs: elapsed, status: res.status }, operationId);
      return data;
    } catch (parseError: any) {
      const mappedError = mapDiagnosticsToUserError(diagnostics);
      logger.error('opencode', 'Message returned non-JSON response body', {
        elapsedMs: elapsed,
        status: res.status,
        contentType: res.headers.get('content-type'),
        bodyPreview: rawBody.slice(0, 200),
        parseError: parseError.message,
        serverStderrTail: diagnostics?.stderr.slice(-20),
        serverStdoutTail: diagnostics?.stdout.slice(-10),
        mappedError,
      }, operationId);
      if (mappedError) {
        throw new Error(mappedError);
      }
      throw new Error('OpenCode returned non-JSON response body');
    }
  } catch (e: any) {
    const elapsed = Date.now() - sendStart;
    if (e.name === 'AbortError') {
      // Check if this was a cancellation vs a timeout
      if (cancellationToken?.isCancelled) {
        logger.info('opencode', 'Message cancelled by user', { elapsedMs: elapsed }, operationId);
        throw new Error('Generation cancelled');
      }
      logger.error('opencode', 'Message aborted (timeout)', { elapsedMs: elapsed }, operationId);
      throw new Error(`OpenCode message timed out after ${MESSAGE_TIMEOUT_MS / 1000}s`);
    }
    logger.error('opencode', 'Message error', { 
      elapsedMs: elapsed, 
      error: e.name, 
      message: e.message,
      serverStderrTail: diagnostics?.stderr.slice(-20),
      serverStdoutTail: diagnostics?.stdout.slice(-10),
    }, operationId);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function deleteSession(port: number, sessionId: string, operationId?: string): Promise<void> {
  logger.debug('opencode', 'Deleting session', { sessionId }, operationId);
  try {
    const res = await fetch(`${baseUrl(port)}/session/${sessionId}`, { method: 'DELETE' });
    logger.debug('opencode', 'Delete session response', { status: res.status }, operationId);
  } catch (e: any) {
    logger.warn('opencode', 'Failed to delete session', { sessionId, error: e.message }, operationId);
  }
}


// =============================================================================
// OPENCODE PROVIDER
// =============================================================================

export class OpenCodeProvider implements ReviewProvider {
  readonly id = 'opencode';
  readonly name = 'OpenCode';

  async generateReview(
    git: GitContext,
    workspaceRoot: string,
    onGroup: (result: StreamingGroupResult) => void | Promise<void>,
    onMetadata: (result: StreamingMetadataResult) => void | Promise<void>,
    onCommitMessage: (result: StreamingCommitMessageResult) => void | Promise<void>,
    cancellationToken?: CancellationToken,
    isLargeDiff?: boolean,
  ): Promise<void> {
    const opId = startOperation('opencode', 'generateReview', {
      workspaceRoot,
      filesChanged: git.filesChanged.length,
      diffLength: git.diff.length
    });

    let server: OpenCodeServer | undefined;
    let sessionId: string | undefined;
    const outputDir = path.join(workspaceRoot, `.ai-review-tmp-${Date.now()}`);

    try {
      server = await acquireServer(workspaceRoot, opId);
      logger.info('opencode', 'Server acquired', { 
        port: server.port, 
        weOwnServer: server.process !== null, 
        forkSession: server.forkSession 
      }, opId);

      // Create or fork a session
      if (server.forkSession) {
        logger.info('opencode', 'Forking existing session', undefined, opId);
        const forked = await forkLatestSession(server.port, workspaceRoot, opId);
        sessionId = forked.id;
        logger.info('opencode', 'Using forked session', { sessionId }, opId);
      } else {
        logger.info('opencode', 'Creating new session', undefined, opId);
        const created = await createSession(server.port, 'Codebrief', workspaceRoot, opId);
        sessionId = created.id;
        logger.info('opencode', 'Using new session', { sessionId }, opId);
      }

      await fs.mkdir(outputDir, { recursive: true });
      logger.info('opencode', 'Temp directory created', { outputDir }, opId);

      const activeServer = server;
      const activeSessionId = sessionId;
      if (!activeServer || !activeSessionId) {
        throw new Error('OpenCode session unavailable');
      }

      const runPrompt = async (prompt: string, startTimeMs?: number) => {
        logger.debug('opencode', 'Prompt built', { promptLength: prompt.length, isLargeDiff: !!isLargeDiff }, opId);

        const poller = pollOutputDir({
          outputDir,
          intervalMs: GROUP_CHECK_INTERVAL_MS,
          component: 'opencode',
          operationId: opId,
          onGroup,
          onMetadata,
          onCommitMessage,
          cancellationToken,
          startTimeMs
        });

        try {
          logger.info('opencode', 'Sending prompt to AI', undefined, opId);
          await sendMessage(activeServer.port, activeSessionId, prompt, activeServer.diagnostics, opId, cancellationToken);
          logger.info('opencode', 'AI message completed', undefined, opId);
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

      // Check if cancelled before marking success
      if (cancellationToken?.isCancelled) {
        endOperation(opId, 'cancelled', { sessionId, outputDir });
        return;
      }

      endOperation(opId, 'success', { sessionId, outputDir });

    } catch (error: any) {
      logger.error('opencode', 'Generation failed', {
        error: error.message,
        stack: error.stack,
        sessionId,
        outputDir
      }, opId);
      endOperation(opId, 'error', { error: error.message, sessionId });
      throw error;
    } finally {
      // Clean up: delete the session
      if (sessionId && server) {
        logger.debug('opencode', 'Cleaning up session', { sessionId }, opId);
        await deleteSession(server.port, sessionId, opId);
      }

      // Kill the server if we started it
      if (server?.process) {
        logger.debug('opencode', 'Stopping server', { pid: server.process.pid }, opId);
        server.process.kill('SIGTERM');
      }

      // Clean up temp dir
      try {
        await fs.rm(outputDir, { recursive: true, force: true });
        logger.debug('opencode', 'Temp directory cleaned up', { outputDir }, opId);
      } catch (e: any) {
        logger.warn('opencode', 'Failed to clean up temp directory', { outputDir, error: e.message }, opId);
      }
    }
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
    logger.error('opencode', 'Failed to read metadata.json after grouping pass', {
      filePath: metadataPath,
      error: error.message
    }, opId);
    throw error;
  }
}
