/**
 * Polling module for watching streaming output files.
 * Uses sampled logging to reduce noise from high-frequency polling.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger, preserveJsonFile, startAnalysisSession } from '../utils/logger';
import { StreamingGroupResult, StreamingMetadataResult, StreamingCommitMessageResult, GroupMetadata } from '../types';
import { CancellationToken } from '../utils';
import { jsonrepair } from 'jsonrepair';

export interface PollingOptions {
  outputDir: string;
  intervalMs: number;
  component: string;
  operationId?: string;
  onGroup: (result: StreamingGroupResult) => void | Promise<void>;
  onMetadata: (result: StreamingMetadataResult) => void | Promise<void>;
  onCommitMessage: (result: StreamingCommitMessageResult) => void | Promise<void>;
  cancellationToken?: CancellationToken;
  startTimeMs?: number;
}

/**
 * Parse JSON content, repairing it if AI Agent returns malformed response.
 * Returns the parsed object or throws if unrecoverable.
 */
function parseJsonWithRepair(content: string, component: string, filePath: string, operationId?: string): { parsed: any; repaired: boolean } {
  try {
    return { parsed: JSON.parse(content), repaired: false };
  } catch {
    try {
      const repaired = jsonrepair(content);
      const parsed = JSON.parse(repaired);
      logger.warn(component, 'JSON repaired from malformed content', {
        filePath,
        originalLength: content.length,
        repairedLength: repaired.length
      }, operationId);
      return { parsed, repaired: true };
    } catch (repairError: any) {
      throw new Error(`JSON parse and repair both failed for ${filePath}: ${repairError.message}`);
    }
  }
}

export function pollOutputDir(options: PollingOptions): { stop: () => Promise<void> } {
  const { outputDir, intervalMs, onGroup, onMetadata, onCommitMessage, component, operationId, cancellationToken, startTimeMs } = options;
  const writtenGroups = new Set<number>();
  let metadataReceived = false;
  let commitMessageReceived = false;
  let isChecking = false;
  let pollCount = 0;
  let metadataFileSize: number | null = null;
  let commitMessageFileSize: number | null = null;
  const groupFileSizes = new Map<number, number>();
  let isStopped = false;

  // Handle cancellation
  cancellationToken?.onCancel(() => {
    logger.debug(component, 'Polling cancelled', { outputDir, pollCount }, operationId);
    isStopped = true;
  });

  // Ensure we have an analysis session for preserving JSON files
  const analysisSession = startAnalysisSession();
  if (analysisSession) {
    logger.debug(component, 'Using analysis session for JSON preservation', {
      outputDir,
      analysisId: analysisSession.id,
      analysisDir: analysisSession.dir
    }, operationId);
  }

  const checkForNewGroups = async () => {
    if (isChecking || isStopped) return;
    isChecking = true;
    pollCount++;

    // Check cancellation at start of each poll
    if (cancellationToken?.isCancelled) {
      isStopped = true;
      isChecking = false;
      return;
    }

    try {
      const files = await fs.readdir(outputDir);

      // Sampled logging: log every 20th poll and when state changes
      if (pollCount === 1 || pollCount % 20 === 0 || files.length > writtenGroups.size + (metadataReceived ? 1 : 0) + (commitMessageReceived ? 1 : 0)) {
        logger.debug(component, 'Polling output directory', {
          pollCount,
          fileCount: files.length,
          jsonFiles: files.filter(f => f.endsWith('.json')).join(', '),
          groupsFound: writtenGroups.size,
          hasMetadata: metadataReceived,
          hasCommitMessage: commitMessageReceived,
          outputDir,
          analysisId: analysisSession?.id
        }, operationId);
      }

      if (!metadataReceived && files.includes('metadata.json')) {
        const metadataPath = path.join(outputDir, 'metadata.json');
        try {
          // Get file stats for size and modification time
          const stats = await fs.stat(metadataPath);
          if (startTimeMs && stats.mtimeMs < startTimeMs) {
            // Ignore metadata from earlier runs
            return;
          }
          metadataFileSize = stats.size;
          
          const content = await fs.readFile(metadataPath, 'utf-8');
          const { parsed: metadata } = parseJsonWithRepair(content, component, metadataPath, operationId);

          if (metadata?.title && metadata?.groups && Array.isArray(metadata.groups)) {
            metadataReceived = true;
            
            // Preserve the metadata file to the analysis directory
            preserveJsonFile(metadataPath, 'metadata.json');
            
            // Log detailed metadata info
            logger.info(component, 'Metadata JSON file detected, parsed, and preserved', {
              filePath: metadataPath,
              fileSize: metadataFileSize,
              analysisId: analysisSession?.id,
              analysisDir: analysisSession?.dir,
              title: metadata.title,
              groupCount: metadata.groups.length,
              groupIds: metadata.groups.map((s: any) => s.id),
              changesAuthoredByAi: metadata.changesAuthoredByAi,
              contentPreview: JSON.stringify(metadata).slice(0, 500)
            }, operationId);

            await onMetadata({
              type: 'metadata',
              title: metadata.title,
              groups: metadata.groups as GroupMetadata[],
              changesAuthoredByAi: typeof metadata.changesAuthoredByAi === 'boolean' ? metadata.changesAuthoredByAi : undefined
            });
          } else {
            logger.warn(component, 'Metadata JSON file has unexpected format', {
              filePath: metadataPath,
              fileSize: metadataFileSize,
              hasTitle: !!metadata?.title,
              hasGroups: !!metadata?.groups,
              isArray: Array.isArray(metadata?.groups),
              actualKeys: metadata ? Object.keys(metadata) : 'null',
              contentPreview: JSON.stringify(metadata).slice(0, 500)
            }, operationId);
          }
        } catch (e: any) {
          logger.error(component, 'Failed to read/parse metadata.json', {
            filePath: metadataPath,
            fileSize: metadataFileSize,
            error: e.message,
            errorType: e.name,
            pollCount
          }, operationId);
        }
      }

      const groupFiles = files
        .filter(f => f.startsWith('group-') && f.endsWith('.json'))
        .sort();

      for (const filename of groupFiles) {
        const match = filename.match(/^group-(\d+)-/);
        if (!match) {
          logger.debug(component, 'Skipping non-matching file', { filename }, operationId);
          continue;
        }

        const index = parseInt(match[1], 10);
        if (writtenGroups.has(index)) continue;

        const filepath = path.join(outputDir, filename);
        try {
          // Get file stats
          const stats = await fs.stat(filepath);
          if (startTimeMs && stats.mtimeMs < startTimeMs) {
            continue;
          }
          groupFileSizes.set(index, stats.size);
          
          const content = await fs.readFile(filepath, 'utf-8');
          const { parsed: group } = parseJsonWithRepair(content, component, filepath, operationId);

          // Validate required fields before accepting this group
          if (typeof group.groupId !== 'string' || typeof group.title !== 'string' || !Array.isArray(group.files)) {
            logger.warn(component, 'Group file missing required fields, skipping', {
              filePath: filepath,
              index,
              hasGroupId: typeof group.groupId,
              hasTitle: typeof group.title,
              hasFiles: Array.isArray(group.files)
            }, operationId);
            continue;
          }

          writtenGroups.add(index);

          // Preserve the group file to the analysis directory
          preserveJsonFile(filepath, filename);
          
          // Log detailed group info
          const fileHunks = group.files?.map((f: any) => ({
            path: f.path,
            hunkCount: f.hunks?.length || 0
          })) || [];
          
          logger.info(component, 'Group JSON file detected, parsed, and preserved', {
            filePath: filepath,
            fileSize: stats.size,
            analysisId: analysisSession?.id,
            analysisDir: analysisSession?.dir,
            index,
            groupId: group.groupId,
            title: group.title,
            fileCount: group.files?.length || 0,
            totalHunks: group.files?.reduce((sum: number, f: any) => sum + (f.hunks?.length || 0), 0) || 0,
            files: fileHunks,
            explanationLength: group.explanation?.length || 0,
            changesAuthoredByAi: group.changesAuthoredByAi,
            contentPreview: JSON.stringify(group).slice(0, 800)
          }, operationId);

          await onGroup({
            group: {
              groupIndex: group.groupIndex,
              groupId: group.groupId,
              title: group.title,
              explanation: group.explanation,
              changesAuthoredByAi: group.changesAuthoredByAi,
              files: group.files
            },
            index
          });
        } catch (e: any) {
          logger.error(component, 'Failed to read/parse group file', {
            filePath: filepath,
            filename,
            index,
            error: e.message,
            errorType: e.name,
            stack: e.stack
          }, operationId);
        }
      }

      // Check for commit-message.json (written after all groups)
      if (!commitMessageReceived && files.includes('commit-message.json')) {
        const commitMessagePath = path.join(outputDir, 'commit-message.json');
        try {
          const stats = await fs.stat(commitMessagePath);
          if (startTimeMs && stats.mtimeMs < startTimeMs) {
            return;
          }
          commitMessageFileSize = stats.size;
          
          const content = await fs.readFile(commitMessagePath, 'utf-8');
          const { parsed: commitData } = parseJsonWithRepair(content, component, commitMessagePath, operationId);

          if (typeof commitData?.message === 'string') {
            commitMessageReceived = true;
            
            // Preserve the commit message file to the analysis directory
            preserveJsonFile(commitMessagePath, 'commit-message.json');
            
            logger.info(component, 'Commit message JSON file detected, parsed, and preserved', {
              filePath: commitMessagePath,
              fileSize: commitMessageFileSize,
              analysisId: analysisSession?.id,
              analysisDir: analysisSession?.dir,
              messageLength: commitData.message.length,
              messagePreview: commitData.message.split('\n')[0].slice(0, 100)
            }, operationId);

            await onCommitMessage({
              type: 'commitMessage',
              message: commitData.message
            });
          } else {
            logger.warn(component, 'Commit message JSON file has unexpected format', {
              filePath: commitMessagePath,
              fileSize: commitMessageFileSize,
              hasMessage: !!commitData?.message,
              actualKeys: commitData ? Object.keys(commitData) : 'null'
            }, operationId);
          }
        } catch (e: any) {
          logger.error(component, 'Failed to read/parse commit-message.json', {
            filePath: commitMessagePath,
            fileSize: commitMessageFileSize,
            error: e.message,
            errorType: e.name,
            pollCount
          }, operationId);
        }
      }
    } catch (error: any) {
      // Directory might not exist yet - only log on first few attempts
      if (pollCount <= 3) {
        logger.debug(component, 'Output directory not ready yet', {
          outputDir,
          pollCount,
          error: error.message
        }, operationId);
      }
    } finally {
      isChecking = false;
    }
  };

  const interval = setInterval(checkForNewGroups, intervalMs);

  logger.debug(component, 'Started polling for JSON output files', {
    outputDir,
    intervalMs,
    operationId,
    analysisId: analysisSession?.id
  });

  return {
    stop: async () => {
      if (isStopped) return;
      isStopped = true;
      
      clearInterval(interval);
      
      // Log summary of all files processed
      logger.info(component, 'Polling stopped - JSON file summary', {
        totalPolls: pollCount,
        groupsFound: writtenGroups.size,
        metadataReceived,
        metadataFileSize,
        commitMessageReceived,
        commitMessageFileSize,
        groupFileSizes: Object.fromEntries(groupFileSizes),
        analysisId: analysisSession?.id,
        analysisDir: analysisSession?.dir,
        expectedFiles: Array.from({length: writtenGroups.size}, (_, i) => `group-${i}-*.json`)
      }, operationId);
      
      await checkForNewGroups();
    }
  };
}
