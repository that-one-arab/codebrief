/**
 * Enhanced logger for Codebrief extension.
 * 
 * Features:
 * - Session-based organization (VS Code session as top-level directory)
 * - Analysis subdirectories for each review generation
 * - Log levels (DEBUG, INFO, WARN, ERROR)
 * - Component-scoped logging with consistent prefixes
 * - Operation tracing with correlation IDs
 * - Cross-platform log directory (XDG-compliant)
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// Types & Configuration
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  [key: string]: unknown;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  operationId?: string;
  message: string;
  context?: LogContext;
  durationMs?: number;
}

interface LoggerConfig {
  minLevel: LogLevel;
  enableConsole: boolean;
  enableSampling: boolean;
  sampleInterval: number;
  enableFileLogging: boolean;
  logDirectory: string;
  maxSessionLogs: number;     // number of session directories to keep
  preserveAnalysisJson: boolean;
}

interface AnalysisSession {
  id: string;
  dir: string;
  startTime: Date;
}

// ============================================================================
// State
// ============================================================================

let outputChannel: vscode.OutputChannel | undefined;
let config: LoggerConfig = {
  minLevel: 'info',
  enableConsole: true,
  enableSampling: true,
  sampleInterval: 10,
  enableFileLogging: true,
  logDirectory: getDefaultLogDirectory(),
  maxSessionLogs: 10,
  preserveAnalysisJson: true
};

// Current VS Code session state
let currentSessionDir: string | null = null;
let currentLogFile: string | null = null;
let logStream: fs.WriteStream | null = null;
let analysisCounter = 0;

// Sampling counters for high-frequency events
const sampleCounters = new Map<string, number>();

// Active operations for tracing
const activeOperations = new Map<string, OperationState>();

interface OperationState {
  id: string;
  component: string;
  startTime: number;
  metadata: LogContext;
}

// ============================================================================
// Directory Management
// ============================================================================

function getDefaultLogDirectory(): string {
  const home = os.homedir();
  
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || home, 'Codebrief', 'logs');
  }
  
  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(xdgDataHome, 'codebrief', 'logs');
}

function formatDateForDir(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function formatTimeForDir(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function rotateSessionDirs(): void {
  if (!config.enableFileLogging) return;
  
  try {
    const logDir = config.logDirectory;
    if (!fs.existsSync(logDir)) return;
    
    // Get all session directories (format: YYYY-MM-DD-HH-MM-SS)
    const sessions = fs.readdirSync(logDir)
      .filter(name => /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/.test(name))
      .map(name => ({
        name,
        path: path.join(logDir, name),
        mtime: fs.statSync(path.join(logDir, name)).mtime
      }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    
    // Remove old sessions beyond maxSessionLogs
    if (sessions.length > config.maxSessionLogs) {
      for (const session of sessions.slice(config.maxSessionLogs)) {
        try {
          fs.rmSync(session.path, { recursive: true, force: true });
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    }
  } catch (e) {
    // Ignore rotation errors
  }
}

function createSessionDir(): string | null {
  if (!config.enableFileLogging) return null;
  
  const logDir = config.logDirectory;
  const sessionDir = path.join(logDir, formatDateForDir(new Date()));
  
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    fs.mkdirSync(sessionDir, { recursive: true });
    
    // Create analysis subdirectory
    const analysisDir = path.join(sessionDir, 'analysis');
    fs.mkdirSync(analysisDir, { recursive: true });
    
    return sessionDir;
  } catch (e) {
    console.error(`Failed to create session directory: ${sessionDir}`, e);
    return null;
  }
}

function openLogFile(): void {
  if (!config.enableFileLogging || !currentSessionDir) return;
  
  if (logStream) {
    logStream.end();
    logStream = null;
  }
  
  currentLogFile = path.join(currentSessionDir, 'codebrief.log');
  
  try {
    logStream = fs.createWriteStream(currentLogFile, { flags: 'a' });
    
    const header = `\n=== Codebrief Log ===\n` +
                   `Session Started: ${new Date().toISOString()}\n` +
                   `PID: ${process.pid}\n` +
                   `Platform: ${process.platform}\n` +
                   `Session Directory: ${currentSessionDir}\n` +
                   `====================\n\n`;
    logStream.write(header);
  } catch (e) {
    console.error(`Failed to open log file: ${currentLogFile}`, e);
    config.enableFileLogging = false;
    currentLogFile = null;
  }
}

function writeToFile(logLine: string): void {
  if (!config.enableFileLogging || !logStream) return;
  
  try {
    logStream.write(logLine + '\n');
  } catch (e) {
    // Silently fail file logging
  }
}

// ============================================================================
// Analysis Session Management
// ============================================================================

/**
 * Start a new analysis session for a review generation.
 * Creates a timestamped subdirectory under analysis/.
 */
export function startAnalysisSession(): AnalysisSession | null {
  // Return existing session if one is already active
  if (currentAnalysis) {
    return currentAnalysis;
  }
  
  if (!config.enableFileLogging || !config.preserveAnalysisJson || !currentSessionDir) {
    return null;
  }
  
  analysisCounter++;
  const startTime = new Date();
  const id = `analysis-${analysisCounter}-${formatTimeForDir(startTime)}`;
  const dir = path.join(currentSessionDir, 'analysis', formatTimeForDir(startTime));
  
  try {
    fs.mkdirSync(dir, { recursive: true });
    
    // Store the session in the module-level variable
    currentAnalysis = { id, dir, startTime };
    
    logger.info('logger', 'Analysis session started', {
      analysisId: id,
      analysisDir: dir,
      analysisNumber: analysisCounter
    });
    
    return currentAnalysis;
  } catch (e) {
    logger.warn('logger', 'Failed to create analysis directory', {
      dir,
      error: String(e)
    });
    return null;
  }
}

let currentAnalysis: AnalysisSession | null = null;

/**
 * Get the current analysis session.
 */
export function getCurrentAnalysis(): AnalysisSession | null {
  return currentAnalysis;
}

/**
 * Preserve a JSON file to the current analysis directory.
 */
export function preserveJsonFile(sourcePath: string, filename: string): void {
  if (!currentAnalysis) {
    // Auto-start an analysis session if one doesn't exist
    currentAnalysis = startAnalysisSession();
    if (!currentAnalysis) return;
  }
  
  try {
    const destPath = path.join(currentAnalysis.dir, filename);
    fs.copyFileSync(sourcePath, destPath);
    
    const stats = fs.statSync(sourcePath);
    logger.debug('logger', 'Preserved JSON file to analysis directory', {
      analysisId: currentAnalysis.id,
      filename,
      originalPath: sourcePath,
      preservedPath: destPath,
      size: stats.size
    });
  } catch (e) {
    logger.warn('logger', 'Failed to preserve JSON file', {
      analysisId: currentAnalysis?.id,
      filename,
      sourcePath,
      error: String(e)
    });
  }
}

/**
 * End the current analysis session.
 */
export function endAnalysisSession(finalContext?: LogContext): void {
  if (!currentAnalysis) return;
  
  const duration = Date.now() - currentAnalysis.startTime.getTime();
  
  logger.info('logger', 'Analysis session ended', {
    analysisId: currentAnalysis.id,
    analysisDir: currentAnalysis.dir,
    durationMs: duration,
    ...finalContext
  });
  
  currentAnalysis = null;
}

/**
 * List all analysis sessions in the current VS Code session.
 */
export function listAnalysisSessions(): Array<{ id: string; path: string; created: Date }> {
  if (!currentSessionDir) return [];
  
  const analysisDir = path.join(currentSessionDir, 'analysis');
  
  try {
    if (!fs.existsSync(analysisDir)) return [];
    
    return fs.readdirSync(analysisDir)
      .map(name => {
        const sessionPath = path.join(analysisDir, name);
        const stat = fs.statSync(sessionPath);
        return { id: name, path: sessionPath, created: stat.mtime };
      })
      .filter(s => s.created)
      .sort((a, b) => b.created.getTime() - a.created.getTime());
  } catch (e) {
    return [];
  }
}

// ============================================================================
// Log Level Utilities
// ============================================================================

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[config.minLevel];
}

function formatLevel(level: LogLevel): string {
  const colors: Record<LogLevel, string> = {
    debug: 'DBG',
    info: 'INF',
    warn: 'WRN',
    error: 'ERR'
  };
  return colors[level];
}

// ============================================================================
// Core Logging
// ============================================================================

function writeLog(entry: LogEntry): void {
  const parts: string[] = [
    `[${entry.timestamp}]`,
    `[${formatLevel(entry.level)}]`,
    entry.operationId ? `[${entry.operationId}]` : '',
    `[${entry.component}]`,
    entry.message
  ].filter(Boolean);

  let logLine = parts.join(' ');

  if (entry.context && Object.keys(entry.context).length > 0) {
    const contextStr = Object.entries(entry.context)
      .map(([k, v]) => {
        if (v === undefined) return `${k}=undefined`;
        if (v === null) return `${k}=null`;
        if (typeof v === 'object') return `${k}=${JSON.stringify(v)}`;
        return `${k}=${v}`;
      })
      .join(', ');
    logLine += ` { ${contextStr} }`;
  }

  if (entry.durationMs !== undefined) {
    logLine += ` (${entry.durationMs.toFixed(1)}ms)`;
  }

  outputChannel?.appendLine(logLine);
  writeToFile(logLine);

  if (config.enableConsole) {
    const consoleMethod = entry.level === 'error' ? console.error :
                         entry.level === 'warn' ? console.warn :
                         entry.level === 'debug' ? console.debug : console.log;
    consoleMethod(logLine);
  }
}

function createLogEntry(
  level: LogLevel,
  component: string,
  message: string,
  context?: LogContext,
  operationId?: string,
  durationMs?: number
): LogEntry {
  return {
    timestamp: new Date().toISOString(),
    level,
    component,
    operationId,
    message,
    context,
    durationMs
  };
}

// ============================================================================
// Public API
// ============================================================================

export function initLogger(channel: vscode.OutputChannel, userConfig?: Partial<LoggerConfig>): void {
  outputChannel = channel;
  if (userConfig) {
    config = { ...config, ...userConfig };
  }
  
  // Ensure logDirectory is never undefined
  if (!config.logDirectory) {
    config.logDirectory = getDefaultLogDirectory();
  }
  
  if (config.enableFileLogging) {
    rotateSessionDirs();
    currentSessionDir = createSessionDir();
    
    if (currentSessionDir) {
      openLogFile();
      
      outputChannel.appendLine(`[Logger] Session directory: ${currentSessionDir}`);
      if (config.preserveAnalysisJson) {
        outputChannel.appendLine(`[Logger] Analysis JSON preservation enabled`);
      }
      
      if (shouldLog('debug')) {
        writeLog(createLogEntry('debug', 'logger', 'Logger initialized', { 
          logDirectory: config.logDirectory,
          sessionDir: currentSessionDir
        }));
      }
    }
  }
}

export function setLogLevel(level: LogLevel): void {
  config.minLevel = level;
  logger.info('logger', 'Log level changed', { level });
}

export function getLogLevel(): LogLevel {
  return config.minLevel;
}

export function getLogDirectory(): string {
  return config.logDirectory || getDefaultLogDirectory();
}

export function getCurrentSessionDir(): string | null {
  return currentSessionDir;
}

export function getCurrentLogFile(): string | null {
  return currentLogFile;
}

export function openLogDirectory(): void {
  const logDir = config.logDirectory || getDefaultLogDirectory();
  
  // Open the session directory if it exists, otherwise the main log directory
  const dirToOpen = currentSessionDir || logDir;
  
  // Create the directory if it doesn't exist
  if (!fs.existsSync(dirToOpen)) {
    try {
      fs.mkdirSync(dirToOpen, { recursive: true });
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to create log directory: ${dirToOpen}`);
      return;
    }
  }
  
  vscode.env.openExternal(vscode.Uri.file(dirToOpen));
}

export function startOperation(
  component: string,
  operationName: string,
  metadata?: LogContext
): string {
  const id = `${operationName}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  
  activeOperations.set(id, {
    id,
    component,
    startTime: Date.now(),
    metadata: metadata || {}
  });

  if (shouldLog('info')) {
    writeLog(createLogEntry('info', component, `Operation started: ${operationName}`, metadata, id));
  }

  return id;
}

export function logOperation(
  level: LogLevel,
  operationId: string,
  message: string,
  context?: LogContext
): void {
  if (!shouldLog(level)) return;

  const op = activeOperations.get(operationId);
  const durationMs = op ? Date.now() - op.startTime : undefined;
  const component = op?.component || 'unknown';

  writeLog(createLogEntry(level, component, message, context, operationId, durationMs));
}

export function endOperation(
  operationId: string,
  status: 'success' | 'error' | 'cancelled' = 'success',
  finalContext?: LogContext
): void {
  const op = activeOperations.get(operationId);
  if (!op) {
    logger.warn('logger', 'Attempted to end unknown operation', { operationId });
    return;
  }

  const durationMs = Date.now() - op.startTime;
  const level = status === 'error' ? 'error' : 'info';
  const message = `Operation ended: ${status}`;

  writeLog(createLogEntry(
    level,
    op.component,
    message,
    { ...op.metadata, ...finalContext, status },
    operationId,
    durationMs
  ));

  activeOperations.delete(operationId);
}

export function sampleLog(
  level: LogLevel,
  component: string,
  eventKey: string,
  message: string,
  context?: LogContext,
  sampleRate?: number
): void {
  if (!config.enableSampling) {
    logger.log(level, component, message, context);
    return;
  }

  const rate = sampleRate || config.sampleInterval;
  const current = (sampleCounters.get(eventKey) || 0) + 1;
  sampleCounters.set(eventKey, current);

  if (current === 1 || current % rate === 0) {
    const sampledContext = { ...context, _sample: `${current}`, _rate: rate };
    logger.log(level, component, message, sampledContext);
  }

  if (current >= rate * 1000) {
    sampleCounters.set(eventKey, 0);
  }
}

export function resetSampling(): void {
  sampleCounters.clear();
}

// ============================================================================
// Main Logger Object
// ============================================================================

export const logger = {
  debug(component: string, message: string, context?: LogContext, operationId?: string): void {
    if (!shouldLog('debug')) return;
    writeLog(createLogEntry('debug', component, message, context, operationId));
  },

  info(component: string, message: string, context?: LogContext, operationId?: string): void {
    if (!shouldLog('info')) return;
    writeLog(createLogEntry('info', component, message, context, operationId));
  },

  warn(component: string, message: string, context?: LogContext, operationId?: string): void {
    if (!shouldLog('warn')) return;
    writeLog(createLogEntry('warn', component, message, context, operationId));
  },

  error(component: string, message: string, context?: LogContext, operationId?: string): void {
    if (!shouldLog('error')) return;
    writeLog(createLogEntry('error', component, message, context, operationId));
  },

  log(level: LogLevel, component: string, message: string, context?: LogContext, operationId?: string): void {
    if (!shouldLog(level)) return;
    writeLog(createLogEntry(level, component, message, context, operationId));
  },

  time<T>(component: string, operation: string, fn: () => T, context?: LogContext): T {
    const start = Date.now();
    try {
      const result = fn();
      if (shouldLog('debug')) {
        writeLog(createLogEntry('debug', component, operation, context, undefined, Date.now() - start));
      }
      return result;
    } catch (error) {
      writeLog(createLogEntry('error', component, `${operation} failed`, {
        ...context,
        error: error instanceof Error ? error.message : String(error)
      }, undefined, Date.now() - start));
      throw error;
    }
  },

  async timeAsync<T>(
    component: string,
    operation: string,
    fn: () => Promise<T>,
    context?: LogContext
  ): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      if (shouldLog('debug')) {
        writeLog(createLogEntry('debug', component, operation, context, undefined, Date.now() - start));
      }
      return result;
    } catch (error) {
      writeLog(createLogEntry('error', component, `${operation} failed`, {
        ...context,
        error: error instanceof Error ? error.message : String(error)
      }, undefined, Date.now() - start));
      throw error;
    }
  },

  startOperation,
  logOperation,
  endOperation,
  sampleLog,
  resetSampling,
  setLogLevel,
  getLogLevel,
  getLogDirectory,
  getCurrentSessionDir,
  getCurrentLogFile,
  openLogDirectory,
  startAnalysisSession,
  getCurrentAnalysis,
  preserveJsonFile,
  endAnalysisSession,
  listAnalysisSessions
};

// ============================================================================
// Backward Compatibility
// ============================================================================

export function log(message: string): void {
  let level: LogLevel = 'info';
  if (message.toLowerCase().includes('error')) level = 'error';
  else if (message.toLowerCase().includes('warning') || message.toLowerCase().includes('warn')) level = 'warn';
  
  const bracketMatch = message.match(/^\[([^\]]+)\]/);
  const component = bracketMatch ? bracketMatch[1] : 'legacy';
  const cleanMessage = bracketMatch ? message.slice(bracketMatch[0].length).trim() : message;
  
  writeLog(createLogEntry(level, component, cleanMessage));
}

export function getOperationState(operationId: string): OperationState | undefined {
  return activeOperations.get(operationId);
}
