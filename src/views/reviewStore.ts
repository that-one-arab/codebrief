/**
 * Review data store - EventEmitter-based single source of truth for review state.
 * Generation writes here; the panel and tree view subscribe to events.
 * Includes comprehensive logging for state transitions.
 */
import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { GroupMetadata, GroupContent, DiffFile } from '../types';
import { mergeReviewWithDiff } from '../utils';
import { logger } from '../utils/logger';

export type ReviewState = 'idle' | 'generating' | 'complete' | 'error' | 'cancelling';

export interface ReviewStoreEvents {
  metadata: [title: string, groups: GroupMetadata[]];
  group: [groupId: string, content: GroupContent];
  commitMessage: [message: string];
  complete: [];
  error: [message: string, canRetry?: boolean];
  stale: [staleFiles: Set<string>];
}

class ReviewStore extends EventEmitter {
  private _state: ReviewState = 'idle';
  private _title: string = 'Codebrief';
  private _groupMetas: GroupMetadata[] = [];
  private _groups: Map<string, GroupContent> = new Map();
  private _errorMessage: string | null = null;
  private _parsedDiff: DiffFile[] = [];
  private _changesAuthoredByAi: boolean | null = null;
  private _providerName: string = '';
  private _stateTransitionCount: number = 0;
  private _currentGenerationId: string | null = null;
  private _suggestedCommitMessage: string | null = null;
  private _reviewedFileHashes: Map<string, string> = new Map();
  private _staleFiles: Set<string> = new Set();

  get state(): ReviewState { return this._state; }
  get title(): string { return this._title; }
  get groupMetas(): GroupMetadata[] { return this._groupMetas; }
  get groups(): Map<string, GroupContent> { return this._groups; }
  get errorMessage(): string | null { return this._errorMessage; }
  get changesAuthoredByAi(): boolean | null { return this._changesAuthoredByAi; }
  get providerName(): string { return this._providerName; }
  get suggestedCommitMessage(): string | null { return this._suggestedCommitMessage; }
  get staleFiles(): ReadonlySet<string> { return new Set(this._staleFiles); }
  get isStale(): boolean { return this._staleFiles.size > 0; }

  private logStateTransition(
    fromState: ReviewState, 
    toState: ReviewState, 
    context?: Record<string, unknown>
  ): void {
    this._stateTransitionCount++;
    logger.debug('reviewStore', 'State transition', {
      from: fromState,
      to: toState,
      transitionCount: this._stateTransitionCount,
      groupsCount: this._groups.size,
      ...context
    });
  }

  /**
   * Begin a new generation cycle. Resets all accumulated state.
   */
  startGeneration(parsedDiff: DiffFile[], generationId?: string): void {
    const prevState = this._state;
    
    this._state = 'generating';
    this._title = 'Codebrief';
    this._groupMetas = [];
    this._groups.clear();
    this._errorMessage = null;
    this._parsedDiff = parsedDiff;
    this._changesAuthoredByAi = null;
    this._providerName = '';
    this._stateTransitionCount = 0;
    this._currentGenerationId = generationId ?? null;
    this._suggestedCommitMessage = null;
    this._reviewedFileHashes.clear();
    this._staleFiles.clear();

    this.logStateTransition(prevState, 'generating', {
      parsedFiles: parsedDiff.length,
      totalHunks: parsedDiff.reduce((sum, f) => sum + f.hunks.length, 0),
      generationId
    });
  }

  /**
   * Get the current generation ID.
   */
  get currentGenerationId(): string | null {
    return this._currentGenerationId;
  }

  /**
   * Check if a given generation ID matches the current active generation.
   */
  isActiveGeneration(generationId: string): boolean {
    return this._currentGenerationId === generationId && this._state === 'generating';
  }

  /**
   * Mark generation as being cancelled.
   */
  setCancelling(): void {
    const prevState = this._state;
    this._state = 'cancelling';
    this.logStateTransition(prevState, 'cancelling');
  }

  setProviderName(name: string): void {
    this._providerName = name;
    logger.debug('reviewStore', 'Provider name set', { name });
  }

  /**
   * Set metadata (title + group skeletons) from streaming response.
   */
  setMetadata(title: string, groups: GroupMetadata[], changesAuthoredByAi?: boolean): void {
    const prevTitle = this._title;
    this._title = title;
    this._groupMetas = groups;
    
    if (typeof changesAuthoredByAi === 'boolean') {
      this._changesAuthoredByAi = changesAuthoredByAi;
    }

    // Pre-populate skeleton entries in the groups map
    for (const meta of groups) {
      this._groups.set(meta.id, { ...meta, explanation: '', files: [] });
    }

    logger.info('reviewStore', 'Metadata set', {
      title,
      groupCount: groups.length,
      changesAuthoredByAi,
      previousTitle: prevTitle !== title ? prevTitle : undefined
    });

    this.emit('metadata', title, groups);
  }

  /**
   * Set the suggested commit message (arrives after all groups).
   */
  setSuggestedCommitMessage(message: string): void {
    this._suggestedCommitMessage = message;

    logger.info('reviewStore', 'Suggested commit message set', {
      messageLength: message.length,
      messagePreview: message.split('\n')[0].slice(0, 100)
    });

    this.emit('commitMessage', message);
  }

  /**
   * Add/update a group with full content. Merges with diff automatically.
   * Returns the merged group, or null if groupId is unknown.
   */
  addGroup(groupId: string, content: GroupContent): GroupContent | null {
    const existing = this._groups.get(groupId);
    if (!existing) {
      logger.warn('reviewStore', 'Group not found for update', {
        groupId,
        availableGroups: Array.from(this._groups.keys())
      });
      return null;
    }

    if (this._changesAuthoredByAi === null && typeof content.changesAuthoredByAi === 'boolean') {
      this._changesAuthoredByAi = content.changesAuthoredByAi;
    }

    logger.debug('reviewStore', 'Starting group merge', {
      groupId,
      title: content.title,
      filesFromAI: content.files?.length || 0,
      explanationLength: content.explanation?.length || 0,
      changesAuthoredByAi: content.changesAuthoredByAi,
      parsedDiffFilesAvailable: this._parsedDiff.length
    });

    const startMerge = Date.now();
    const merged: GroupContent = {
      ...existing,
      ...content,
      id: groupId
    };

    // Merge with diff data to get line-level info
    const withLines = mergeReviewWithDiff(merged, this._parsedDiff, groupId);
    this._groups.set(groupId, withLines);

    const mergeTime = Date.now() - startMerge;
    const fileCount = withLines.files?.length || 0;
    const hunkCount = withLines.files?.reduce((sum: number, f: any) => sum + (f.hunks?.length || 0), 0) || 0;
    
    // Log file-level details
    const fileDetails = withLines.files?.map((f: any) => ({
      path: f.path,
      hunkCount: f.hunks?.length || 0,
      totalLines: f.hunks?.reduce((sum: number, h: any) => sum + (h.lines?.length || 0), 0) || 0
    })) || [];

    logger.info('reviewStore', 'Group merged with diff', {
      groupId,
      title: withLines.title,
      fileCount,
      hunkCount,
      mergeTimeMs: mergeTime,
      files: fileDetails,
      hasExplanation: !!withLines.explanation,
      explanationLength: withLines.explanation?.length || 0
    });

    this.emit('group', groupId, withLines);
    return withLines;
  }

  /**
   * Mark generation as complete. Computes file hashes for staleness
   * tracking before emitting the complete event.
   */
  async completeGeneration(workspaceRoot?: string): Promise<void> {
    const prevState = this._state;
    this._state = 'complete';

    const populatedGroups = Array.from(this._groups.values()).filter(
      g => g.explanation || (g.files && g.files.length > 0)
    ).length;

    this.logStateTransition(prevState, 'complete', {
      totalGroups: this._groups.size,
      populatedGroups,
      provider: this._providerName
    });

    if (workspaceRoot) {
      await this.computeAndStoreFileHashes(workspaceRoot);
    }

    this.emit('complete');
  }

  /**
   * Compute and store content hashes for all reviewed files.
   */
  private async computeAndStoreFileHashes(workspaceRoot: string): Promise<void> {
    this._reviewedFileHashes.clear();
    const filePaths = new Set<string>();
    for (const group of this._groups.values()) {
      for (const file of group.files || []) {
        filePaths.add(file.path);
      }
    }

    await Promise.all([...filePaths].map(async (filePath) => {
      const absPath = path.resolve(workspaceRoot, filePath);
      try {
        const content = await fs.readFile(absPath);
        const hash = createHash('sha256').update(content).digest('hex');
        this._reviewedFileHashes.set(filePath, hash);
      } catch {
        this._reviewedFileHashes.set(filePath, '__deleted__');
      }
    }));

    logger.debug('reviewStore', 'File hashes computed', {
      fileCount: this._reviewedFileHashes.size
    });
  }

  /**
   * Re-hash current files and update the stale set.
   * Emits 'stale' event if the stale set changed.
   */
  async updateStaleness(workspaceRoot: string): Promise<void> {
    if (this._state !== 'complete' || this._reviewedFileHashes.size === 0) {
      return;
    }

    const newStale = new Set<string>();
    await Promise.all([...this._reviewedFileHashes].map(async ([filePath, oldHash]) => {
      const absPath = path.resolve(workspaceRoot, filePath);
      let currentHash: string;
      try {
        const content = await fs.readFile(absPath);
        currentHash = createHash('sha256').update(content).digest('hex');
      } catch {
        currentHash = '__deleted__';
      }
      if (currentHash !== oldHash) {
        newStale.add(filePath);
      }
    }));

    // Only emit if the stale set actually changed
    const changed = newStale.size !== this._staleFiles.size ||
      [...newStale].some(f => !this._staleFiles.has(f));

    if (changed) {
      this._staleFiles = newStale;
      logger.info('reviewStore', 'Staleness updated', {
        staleCount: newStale.size,
        staleFiles: [...newStale]
      });
      this.emit('stale', new Set(this._staleFiles));
    }
  }

  /**
   * Record an error during generation.
   */
  setError(message: string, canRetry?: boolean): void {
    const prevState = this._state;
    this._state = 'error';
    this._errorMessage = message;

    this.logStateTransition(prevState, 'error', {
      error: message,
      canRetry,
      groupsAtError: this._groups.size
    });

    this.emit('error', message, canRetry);
  }

  /**
   * Backward-compatible: reconstruct the legacy review data shape.
   */
  getCurrentReviewData(): any {
    if (this._groupMetas.length === 0) { return null; }

    return {
      title: this._title,
      changesAuthoredByAi: this._changesAuthoredByAi ?? undefined,
      groups: this._groupMetas.map((meta) => {
        const content = this._groups.get(meta.id);
        return {
          id: content?.id || meta.id,
          title: content?.title || meta.title,
          explanation: content?.explanation || '',
          files: content?.files || []
        };
      })
    };
  }
}

export const reviewStore = new ReviewStore();

// Backward-compatible exports — delegate to the singleton store
export function setCurrentReviewData(_data: any): void {
  // No-op: store is now the source of truth, populated via setMetadata/addGroup
  logger.debug('reviewStore', 'setCurrentReviewData called (deprecated, no-op)');
}

export function getCurrentReviewData(): any {
  return reviewStore.getCurrentReviewData();
}

export function clearReviewData(): void {
  logger.debug('reviewStore', 'Clearing review data');
  reviewStore.startGeneration([]);
}
