/**
 * Generation Controller - Manages concurrent review generation requests.
 * 
 * When a new review is requested during an ongoing one, the previous
 * generation is cancelled and the new one proceeds with a fresh state.
 */

import { EventEmitter } from 'events';
import { logger } from './logger';

export interface CancellationToken {
  readonly isCancelled: boolean;
  readonly generationId: string;
  onCancel(callback: () => void): void;
}

class CancellationTokenImpl implements CancellationToken {
  private _isCancelled = false;
  private _callbacks: Array<() => void> = [];
  private _generationId: string;

  constructor(generationId: string) {
    this._generationId = generationId;
  }

  get isCancelled(): boolean {
    return this._isCancelled;
  }

  get generationId(): string {
    return this._generationId;
  }

  cancel(): void {
    if (this._isCancelled) return;
    this._isCancelled = true;
    logger.debug('generationController', 'Generation cancelled', { generationId: this._generationId });
    for (const callback of this._callbacks) {
      try {
        callback();
      } catch (e) {
        logger.error('generationController', 'Error in cancel callback', { error: String(e) });
      }
    }
  }

  onCancel(callback: () => void): void {
    if (this._isCancelled) {
      callback();
    } else {
      this._callbacks.push(callback);
    }
  }
}

export interface GenerationContext {
  readonly id: string;
  readonly token: CancellationToken;
  readonly startTime: number;
}

class GenerationController extends EventEmitter {
  private _currentGeneration: GenerationContext | null = null;
  private _generationCounter = 0;

  get currentGeneration(): GenerationContext | null {
    return this._currentGeneration;
  }

  /**
   * Start a new generation, cancelling any existing one.
   * Returns the new generation context.
   */
  startNewGeneration(): GenerationContext {
    // Cancel any existing generation first
    if (this._currentGeneration) {
      const prevId = this._currentGeneration.id;
      logger.info('generationController', 'Cancelling previous generation for new request', {
        previousId: prevId,
        elapsedMs: Date.now() - this._currentGeneration.startTime
      });
      (this._currentGeneration.token as CancellationTokenImpl).cancel();
      this.emit('generationCancelled', this._currentGeneration);
    }

    this._generationCounter++;
    const generationId = `gen-${Date.now()}-${this._generationCounter}`;
    const token = new CancellationTokenImpl(generationId);
    
    this._currentGeneration = {
      id: generationId,
      token,
      startTime: Date.now()
    };

    logger.info('generationController', 'New generation started', {
      generationId,
      previousGeneration: this._currentGeneration ? 'cancelled' : 'none'
    });

    this.emit('generationStarted', this._currentGeneration);
    return this._currentGeneration;
  }

  /**
   * Check if a given generation is still the active one.
   */
  isActiveGeneration(generationId: string): boolean {
    return this._currentGeneration?.id === generationId && !this._currentGeneration.token.isCancelled;
  }

  /**
   * Check if there's a generation currently in progress.
   * Returns true only if a generation is active (not cancelled and not completed).
   */
  get hasActiveGeneration(): boolean {
    return this._currentGeneration !== null && !this._currentGeneration.token.isCancelled;
  }

  /**
   * Mark the current generation as complete.
   */
  completeGeneration(generationId: string): void {
    if (this._currentGeneration?.id === generationId) {
      logger.debug('generationController', 'Generation completed', {
        generationId,
        durationMs: Date.now() - this._currentGeneration.startTime
      });
      this.emit('generationCompleted', this._currentGeneration);
      // Don't clear currentGeneration - it holds the completed state
      // Just mark it as no longer active for new operations
    }
  }

  /**
   * Get a cancellation token for the current generation.
   */
  getCurrentToken(): CancellationToken | null {
    return this._currentGeneration?.token ?? null;
  }
}

export const generationController = new GenerationController();

/**
 * Utility to check if an operation should continue or has been cancelled.
 * Throws an error if the operation should be aborted.
 */
export function throwIfCancelled(token: CancellationToken, operation: string): void {
  if (token.isCancelled) {
    logger.debug('generationController', 'Operation aborted due to cancellation', {
      operation,
      generationId: token.generationId
    });
    throw new GenerationCancelledError(token.generationId);
  }
}

export class GenerationCancelledError extends Error {
  readonly generationId: string;

  constructor(generationId: string) {
    super(`Generation ${generationId} was cancelled`);
    this.name = 'GenerationCancelledError';
    this.generationId = generationId;
  }
}

export class ReviewIncompleteError extends Error {
  readonly reason: string;
  readonly cause?: string; // 'diff-parse-failure' = deterministic, don't retry

  constructor(reason: string, cause?: string) {
    super(`Review output incomplete: ${reason}`);
    this.name = 'ReviewIncompleteError';
    this.reason = reason;
    this.cause = cause;
  }
}
