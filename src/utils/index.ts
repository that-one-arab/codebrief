/**
 * Utility modules for Codebrief.
 */

export * from './diffParser';
export * from './highlighter';
export * from './reviewMerger';
export * from './themeLoader';
export * from './tokenEstimator';

// Logger exports - both legacy and new API
export { 
  log, 
  initLogger, 
  logger, 
  startOperation, 
  endOperation, 
  logOperation, 
  sampleLog,
  resetSampling,
  setLogLevel, 
  getLogLevel,
  getOperationState,
  getLogDirectory,
  getCurrentSessionDir,
  getCurrentLogFile,
  openLogDirectory,
  startAnalysisSession,
  getCurrentAnalysis,
  preserveJsonFile,
  endAnalysisSession
} from './logger';
export type { LogLevel, LogContext, LogEntry } from './logger';

// Generation Controller exports
export {
  generationController,
  throwIfCancelled,
  GenerationCancelledError,
  ReviewIncompleteError
} from './generationController';
export type { CancellationToken, GenerationContext } from './generationController';
