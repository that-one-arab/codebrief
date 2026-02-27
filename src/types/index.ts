/**
 * Type definitions for Codebrief extension.
 * Centralized type exports for better maintainability.
 */

// ============================================================================
// Git Types
// ============================================================================

export interface DiffLine {
  type: 'add' | 'del' | 'context';
  content: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  hunks: DiffHunk[];
}

export interface FileSummary {
  path: string;
  hunks: number;
  additions: number;
  deletions: number;
  linesChanged: number;
}

export interface GitContext {
  head: string;
  branch: string;
  diff: string;
  status: string;
  recentCommits: string;
  filesChanged: string[];
  parsedDiff: DiffFile[];
}

// ============================================================================
// Review Types
// ============================================================================

export type Status = 'pending' | 'accepted' | 'rejected';

export interface GroupMetadata {
  id: string;
  title: string;
  fileCount?: number;
  estimatedLines?: number;
  files?: string[] | GroupFile[];
}

/** File info for a group (from AI provider) */
export interface GroupFile {
  path: string;
  hunks: {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines?: DiffLine[];
  }[];
}

export interface GroupContent extends GroupMetadata {
  explanation: string;
  files?: GroupFile[];
  changesAuthoredByAi?: boolean;
}

export interface IntentGroupData {
  id: string;
  title: string;
  explanation: string;
  files: IntentGroupFile[];
}

/** File info for IntentGroupData (used in tree view) */
export interface IntentGroupFile {
  path: string;
  lines: number;
  additions: number;
  deletions: number;
  hunks?: DiffHunk[];
}

// ============================================================================
// Claude API Types
// ============================================================================

export interface StreamingGroupResult {
  index: number;
  group: {
    groupIndex?: number;
    groupId: string;
    title: string;
    explanation?: string;
    changesAuthoredByAi?: boolean;
    files?: GroupFile[];
  };
}

/**
 * Result for the metadata file in unified streaming mode.
 * This is emitted when the metadata.json file is detected.
 */
export interface StreamingMetadataResult {
  type: 'metadata';
  title: string;
  groups: GroupMetadata[];
  changesAuthoredByAi?: boolean;
}

/**
 * Result for the commit message file in unified streaming mode.
 * This is emitted when the commit-message.json file is detected.
 */
export interface StreamingCommitMessageResult {
  type: 'commitMessage';
  message: string;
}

// ============================================================================
// WebView Message Types
// ============================================================================

export type WebViewCommand = 
  | { command: 'webviewReady' }
  | { command: 'openFile'; path: string; line: number }
  | { command: 'loadContext'; filePath: string; fromLine: number; toLine: number; oldLineStart: number; insertId: string }
  | { command: 'retry' };

export type ExtensionCommand =
  | { command: 'setLoading'; message: string }
  | { command: 'initGroups'; title: string; groups: Array<GroupMetadata & { index: number }>; changesAuthoredByAi?: boolean; providerName?: string; suggestedCommitMessage?: string }
  | { command: 'updateGroup'; groupId: string; group: any }
  | { command: 'updateCommitMessage'; message: string }
  | { command: 'complete' }
  | { command: 'error'; message: string; canRetry?: boolean }
  | { command: 'contextLoaded'; insertId: string; tokenizedLines: any[]; fromLine: number; toLine: number; oldLineStart: number; totalFileLines: number }
  | { command: 'focusFile'; filePath: string };
