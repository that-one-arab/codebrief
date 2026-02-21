import * as vscode from 'vscode';
import { GroupContent, StreamingGroupResult, StreamingMetadataResult, StreamingCommitMessageResult } from './types';
import {
  logger,
  startOperation,
  endOperation,
  getOperationState,
  startAnalysisSession,
  endAnalysisSession,
  generationController,
  throwIfCancelled,
  GenerationCancelledError,
  ReviewIncompleteError,
  findUncoveredHunks,
  estimateTokens,
  LARGE_DIFF_TOKEN_THRESHOLD,
} from './utils';
import { getGitContext, isGitRepository } from './services';
import { ReviewProvider } from './providers';
import { IntentReviewProvider } from './views';
import { reviewStore } from './views';
import { GroupMetadata } from './types';
import { initIntentGroups, updateIntentGroupFiles, finalizeIntentProvider } from './review/intentSync';

export async function generateReview(
  workspaceRoot: string,
  provider: ReviewProvider,
  intentProvider?: IntentReviewProvider
): Promise<void> {
  // Start a new generation - this cancels any existing generation
  const generation = generationController.startNewGeneration();
  const generationId = generation.id;
  const token = generation.token;

  // Start a new analysis session for this review generation
  const analysisSession = startAnalysisSession();
  
  const opId = startOperation('reviewGenerator', 'generateReview', {
    workspaceRoot,
    provider: provider.name,
    providerId: provider.id,
    analysisId: analysisSession?.id,
    analysisDir: analysisSession?.dir,
    generationId
  });

  // Clear the tree view immediately so old data doesn't linger
  // until the new metadata arrives
  intentProvider?.clear();

  try {
    logger.info('reviewGenerator', 'Starting review generation', {
      workspaceRoot,
      provider: provider.name,
      analysisId: analysisSession?.id,
      analysisDir: analysisSession?.dir,
      generationId
    }, opId);

    throwIfCancelled(token, 'pre-git-check');

    if (!isGitRepository(workspaceRoot)) {
      throw new Error('Not a git repository');
    }

    const git = logger.timeAsync('gitService', 'getGitContext', async () => {
      return getGitContext(workspaceRoot);
    });

    const gitContext = await git;
    
    throwIfCancelled(token, 'post-git-context');
    
    const estimatedTokens = estimateTokens(gitContext.diff);
    const isLargeDiff = estimatedTokens > LARGE_DIFF_TOKEN_THRESHOLD;

    logger.info('reviewGenerator', 'Git context obtained', {
      filesChanged: gitContext.filesChanged.length,
      branch: gitContext.branch,
      head: gitContext.head,
      diffLength: gitContext.diff.length,
      parsedFiles: gitContext.parsedDiff.length,
      totalHunks: gitContext.parsedDiff.reduce((sum, f) => sum + f.hunks.length, 0),
      estimatedTokens,
      isLargeDiff,
      generationId
    }, opId);

    if (isLargeDiff) {
      vscode.window.showWarningMessage(
        'Your code changes are very large and may produce inconsistent results.'
      );
      logger.warn('reviewGenerator', 'Large diff detected, using agent-driven mode', {
        estimatedTokens, diffLength: gitContext.diff.length
      });
    }

    // Reset the store for a new generation with generation ID
    reviewStore.startGeneration(gitContext.parsedDiff, generationId);
    reviewStore.setProviderName(provider.name);

    let groups: GroupMetadata[] = [];
    let reviewTitle = 'Codebrief';
    let metadataReceived = false;

    const groupContents = new Map<number, GroupContent>();
    let firstGroupTime: number | null = null;

    // Buffer for groups that arrive before metadata
    const earlyGroupsBuffer = new Map<number, StreamingGroupResult>();

    // Process a single group result (extracted for reuse)
    const processGroupResult = async (result: StreamingGroupResult): Promise<void> => {
      const groupData = result.group;
      const index = groupData.groupIndex ?? result.index;

      if (firstGroupTime === null) {
        firstGroupTime = Date.now();
        const opState = getOperationState(opId);
        const elapsed = opState ? firstGroupTime - opState.startTime : 0;
        logger.info('reviewGenerator', 'First group content received', {
          groupIndex: index,
          groupId: groupData.groupId,
          timeToFirstGroupMs: elapsed,
          generationId
        }, opId);
      }

      const groupContent: GroupContent = {
        id: groupData.groupId,
        title: groupData.title,
        explanation: groupData.explanation || '',
        files: groupData.files || [],
        changesAuthoredByAi: groupData.changesAuthoredByAi
      };

      // Write to store (merges with diff) - but only if still the active generation
      if (!reviewStore.isActiveGeneration(generationId)) {
        logger.debug('reviewGenerator', 'Skipping group add - not active generation', { generationId }, opId);
        return;
      }

      const groupWithLines = reviewStore.addGroup(groupData.groupId, groupContent);

      if (!groupWithLines) {
        // Check if this is because of a new generation
        if (token.isCancelled) {
          return;
        }
        const errorMsg = `Group "${groupData.groupId}" not found. The review structure may have changed.`;
        logger.error('reviewGenerator', 'Group merge failed', {
          groupId: groupData.groupId,
          availableGroups: Array.from(reviewStore.groups.keys()),
          generationId
        }, opId);
        reviewStore.setError(errorMsg, true);
        return;
      }

      // Update the tree view
      if (intentProvider) {
        updateIntentGroupFiles(intentProvider, groupData.groupId, groupWithLines, groupData.explanation || '');
      }

      groupContents.set(index, groupWithLines);

      logger.debug('reviewGenerator', 'Group received', {
        index: index + 1,
        total: groups.length,
        groupId: groupData.groupId,
        title: groupData.title,
        fileCount: groupData.files?.length || 0,
        generationId
      }, opId);
    };

    // Callback for when metadata.json is detected
    const onMetadata = async (result: StreamingMetadataResult) => {
      // Silently ignore callbacks from cancelled generations
      if (token.isCancelled) {
        logger.debug('reviewGenerator', 'Metadata callback ignored - generation cancelled', { generationId }, opId);
        return;
      }

      if (metadataReceived) {
        logger.warn('reviewGenerator', 'Duplicate metadata received, ignoring', undefined, opId);
        return;
      }
      metadataReceived = true;

      reviewTitle = result.title;
      groups = result.groups;
      
      logger.info('reviewGenerator', 'Metadata received', {
        title: reviewTitle,
        groupCount: groups.length,
        changesAuthoredByAi: result.changesAuthoredByAi,
        generationId
      }, opId);

      // Initialize groups in the tree view immediately
      if (intentProvider) {
        initIntentGroups(intentProvider, groups.map(g => ({ id: g.id, title: g.title })));
      }

      // Write metadata to the store
      reviewStore.setMetadata(reviewTitle, groups, result.changesAuthoredByAi);

      // Process any buffered groups that arrived before metadata
      if (earlyGroupsBuffer.size > 0) {
        logger.info('reviewGenerator', 'Processing buffered early groups', {
          bufferedCount: earlyGroupsBuffer.size,
          generationId
        }, opId);

        for (const [index, bufferedResult] of earlyGroupsBuffer) {
          if (index >= 0 && index < groups.length) {
            await processGroupResult(bufferedResult);
          } else {
            logger.warn('reviewGenerator', 'Buffered group has invalid index after metadata', {
              index,
              groupsLength: groups.length,
              groupId: bufferedResult.group.groupId,
              generationId
            }, opId);
          }
        }
        earlyGroupsBuffer.clear();
      }
    };

    // Callback for when each group file is detected
    const onGroup = async (result: StreamingGroupResult) => {
      // Silently ignore callbacks from cancelled generations
      if (token.isCancelled) {
        logger.debug('reviewGenerator', 'Group callback ignored - generation cancelled', { generationId }, opId);
        return;
      }

      const groupData = result.group;
      const index = groupData.groupIndex ?? result.index;

      if (index === undefined || index < 0) {
        logger.warn('reviewGenerator', 'Invalid group index received', {
          index,
          groupsLength: groups.length,
          groupId: groupData.groupId,
          generationId
        }, opId);
        return;
      }

      // If metadata hasn't arrived yet, buffer this group for later processing
      if (!metadataReceived || groups.length === 0) {
        logger.debug('reviewGenerator', 'Buffering group - metadata not yet received', {
          index,
          groupId: groupData.groupId,
          generationId
        }, opId);
        earlyGroupsBuffer.set(index, result);
        return;
      }

      if (index >= groups.length) {
        logger.warn('reviewGenerator', 'Group index out of bounds', {
          index,
          groupsLength: groups.length,
          groupId: groupData.groupId,
          generationId
        }, opId);
        return;
      }

      await processGroupResult(result);
    };

    // Callback for when commit-message.json is detected (after all groups)
    const onCommitMessage = async (result: StreamingCommitMessageResult) => {
      if (token.isCancelled) {
        logger.debug('reviewGenerator', 'Commit message callback ignored - generation cancelled', { generationId }, opId);
        return;
      }

      logger.info('reviewGenerator', 'Commit message received', {
        messageLength: result.message.length,
        messagePreview: result.message.split('\n')[0].slice(0, 100),
        generationId
      }, opId);

      reviewStore.setSuggestedCommitMessage(result.message);
    };

    try {
      await logger.timeAsync(
        'reviewGenerator',
        'AI provider streaming',
        () => provider.generateReview(gitContext, workspaceRoot, onGroup, onMetadata, onCommitMessage, token, isLargeDiff)
      );
      
      throwIfCancelled(token, 'post-streaming');

      // Validate that streaming produced a complete review
      if (!metadataReceived) {
        throw new ReviewIncompleteError('metadata not received');
      }
      if (groupContents.size === 0 && groups.length > 0) {
        throw new ReviewIncompleteError('no group content received');
      }

      // Validate that all diff hunks are covered by the AI groups
      const uncovered = findUncoveredHunks(gitContext.parsedDiff, reviewStore.groups);
      if (uncovered.length > 0) {
        const totalHunks = gitContext.parsedDiff.reduce((sum, f) => sum + f.hunks.length, 0);
        const pct = Math.round((uncovered.length / totalHunks) * 100);
        throw new ReviewIncompleteError(
          `${uncovered.length}/${totalHunks} hunks (${pct}%) not assigned to any group`
        );
      }

      logger.info('reviewGenerator', 'Streaming complete', {
        groupsReceived: groupContents.size,
        groupsExpected: groups.length,
        analysisId: analysisSession?.id,
        preservedFilesDir: analysisSession?.dir,
        generationId
      }, opId);
    } catch (error: any) {
      // Handle cancellation gracefully
      if (error instanceof GenerationCancelledError || token.isCancelled) {
        logger.info('reviewGenerator', 'Generation was cancelled', { generationId }, opId);
        throw error; // Re-throw to be handled by outer catch
      }

      // Rethrow ReviewIncompleteError for retry handling by caller
      if (error instanceof ReviewIncompleteError) {
        logger.warn('reviewGenerator', 'Review output incomplete', {
          reason: error.reason,
          metadataReceived,
          groupsReceived: groupContents.size,
          groupsExpected: groups.length,
          earlyGroupsBuffered: earlyGroupsBuffer.size,
          generationId
        }, opId);
        throw error;
      }

      logger.error('reviewGenerator', 'Streaming error', {
        error: error.message,
        metadataReceived,
        groupsReceived: groupContents.size,
        groupsExpected: groups.length,
        generationId
      }, opId);

      if (!metadataReceived) {
        throw new Error(`Failed to receive review metadata: ${error.message}`);
      }

      if (groupContents.size > 0) {
        logger.warn('reviewGenerator', 'Partial results available', {
          received: groupContents.size,
          expected: groups.length,
          generationId
        }, opId);
        reviewStore.setError(`Warning: Only received ${groupContents.size}/${groups.length} groups. ${error.message}`);
      } else {
        throw error;
      }
    }

    // Check cancellation before finalizing
    throwIfCancelled(token, 'pre-complete');

    // Mark generation complete
    await reviewStore.completeGeneration(workspaceRoot);
    generationController.completeGeneration(generationId);

    const finalStats = reviewStore.getCurrentReviewData();
    logger.info('reviewGenerator', 'Review generation complete', {
      title: reviewTitle,
      groupsTotal: groups.length,
      groupsPopulated: finalStats?.groups?.length || 0,
      analysisId: analysisSession?.id,
      preservedFilesLocation: analysisSession?.dir || 'N/A',
      generationId
    }, opId);

    if (intentProvider) {
      finalizeIntentProvider(intentProvider);
    }

    vscode.window.showInformationMessage(
      `Codebrief complete! ${groups.length} groups analyzed.`
    );

    endOperation(opId, 'success', {
      groupsCount: groups.length,
      provider: provider.name,
      analysisId: analysisSession?.id,
      generationId
    });
    
    endAnalysisSession({
      groupsCount: groups.length,
      provider: provider.name,
      success: true,
      generationId
    });

  } catch (error: any) {
    // Handle cancellation gracefully - don't show error message
    if (error instanceof GenerationCancelledError || token.isCancelled) {
      logger.info('reviewGenerator', 'Generation cancelled cleanly', {
        generationId,
        durationMs: Date.now() - generation.startTime
      }, opId);
      
      endOperation(opId, 'cancelled', { generationId });
      endAnalysisSession({
        cancelled: true,
        provider: provider.name,
        success: false,
        generationId
      });
      
      // Don't throw - cancellation is expected behavior
      return;
    }

    logger.error('reviewGenerator', 'Review generation failed', {
      error: error.message,
      stack: error.stack,
      workspaceRoot,
      provider: provider.name,
      analysisId: analysisSession?.id,
      generationId
    }, opId);
    
    reviewStore.setError(`Failed to generate review: ${error.message}`);
    endOperation(opId, 'error', { error: error.message, analysisId: analysisSession?.id, generationId });
    
    endAnalysisSession({
      error: error.message,
      provider: provider.name,
      success: false,
      generationId
    });
    
    throw error;
  }
}
