import { StreamingGroupResult, StreamingMetadataResult, StreamingCommitMessageResult, GitContext } from '../types';
import { CancellationToken } from '../utils';

export interface ReviewProvider {
  readonly id: string;
  readonly name: string;

  generateReview(
    git: GitContext,
    workspaceRoot: string,
    onGroup: (result: StreamingGroupResult) => void | Promise<void>,
    onMetadata: (result: StreamingMetadataResult) => void | Promise<void>,
    onCommitMessage: (result: StreamingCommitMessageResult) => void | Promise<void>,
    cancellationToken?: CancellationToken,
    isLargeDiff?: boolean,
  ): Promise<void>;
}
