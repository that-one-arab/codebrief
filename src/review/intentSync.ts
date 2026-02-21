import * as vscode from 'vscode';
import { IntentReviewProvider } from '../views';
import { IntentGroupData } from '../types';
import { reviewStore } from '../views';

export function initIntentGroups(intentProvider: IntentReviewProvider, groups: Array<{ id: string; title: string }>): void {
  intentProvider.initGroupsFromMetadata(groups);
}

export function updateIntentGroupFiles(
  intentProvider: IntentReviewProvider,
  groupId: string,
  groupWithLines: any,
  explanation: string
): void {
  const groupFiles = (groupWithLines.files || []).map((file: any) => ({
    path: file.path,
    lines: file.hunks?.reduce((sum: number, h: any) => sum + (h.lines?.length || 0), 0) || 0,
    additions: file.hunks?.reduce((sum: number, h: any) => sum + (h.lines?.filter((l: any) => l.type === 'add').length || 0), 0) || 0,
    deletions: file.hunks?.reduce((sum: number, h: any) => sum + (h.lines?.filter((l: any) => l.type === 'delete').length || 0), 0) || 0,
    hunks: file.hunks
  }));
  intentProvider.updateGroupFiles(groupId, groupFiles, explanation);
}

export function finalizeIntentProvider(intentProvider: IntentReviewProvider): void {
  const reviewData = reviewStore.getCurrentReviewData();
  const groupsData = reviewData?.groups || [];

  const intentGroups: IntentGroupData[] = groupsData.map((group: any, index: number) => ({
    id: group.id || `group-${index}`,
    title: group.title,
    explanation: group.explanation,
    files: (group.files || []).map((file: any) => ({
      path: file.path,
      lines: file.hunks?.reduce((sum: number, h: any) => sum + (h.lines?.length || 0), 0) || 0,
      additions: file.hunks?.reduce((sum: number, h: any) => sum + (h.lines?.filter((l: any) => l.type === 'add').length || 0), 0) || 0,
      deletions: file.hunks?.reduce((sum: number, h: any) => sum + (h.lines?.filter((l: any) => l.type === 'delete').length || 0), 0) || 0,
      hunks: file.hunks
    }))
  }));

  intentProvider.loadReviewData({ groups: intentGroups });

  // Review data loaded successfully - hide the welcome message
  vscode.commands.executeCommand('setContext', 'aiCodeReview:noReviewGenerated', false);
}
