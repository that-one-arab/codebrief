import { describe, it, expect } from 'vitest';
import { classifyFiles } from './agentDrivenPrompt';

describe('classifyFiles', () => {
  it('classifies modified files as M', () => {
    const status = ' M src/workers/llm_worker.py';
    expect(classifyFiles(status)).toBe('M src/workers/llm_worker.py');
  });

  it('classifies untracked files as A', () => {
    const status = '?? new-file.ts';
    expect(classifyFiles(status)).toBe('A new-file.ts');
  });

  it('classifies staged added files as A', () => {
    const status = 'A  src/newModule.ts';
    expect(classifyFiles(status)).toBe('A src/newModule.ts');
  });

  it('classifies staged modified files as M', () => {
    const status = 'M  src/existing.ts';
    expect(classifyFiles(status)).toBe('M src/existing.ts');
  });

  it('classifies files modified in both index and worktree as M', () => {
    const status = 'MM src/both.ts';
    expect(classifyFiles(status)).toBe('M src/both.ts');
  });

  it('filters out directories (nested repos)', () => {
    const status = [
      ' M src/real-file.ts',
      '?? mcp_servers/applescript-mcp/',
      '?? mcp_servers/google-calendar-mcp/',
    ].join('\n');
    expect(classifyFiles(status)).toBe('M src/real-file.ts');
  });

  it('filters out deleted files', () => {
    const status = [
      ' M src/kept.ts',
      ' D src/removed.ts',
      'D  src/staged-delete.ts',
    ].join('\n');
    expect(classifyFiles(status)).toBe('M src/kept.ts');
  });

  it('handles a mixed status output', () => {
    const status = [
      ' M src/workers/llm_worker.py',
      ' M src/workers/screenshot_worker.py',
      '?? src/newUtil.ts',
      'A  src/added.ts',
      ' D src/old.ts',
      '?? nested-repo/',
      'M  src/index.ts',
    ].join('\n');

    const result = classifyFiles(status);
    const lines = result.split('\n');

    expect(lines).toEqual([
      'M src/workers/llm_worker.py',
      'M src/workers/screenshot_worker.py',
      'A src/newUtil.ts',
      'A src/added.ts',
      'M src/index.ts',
    ]);
  });

  it('returns empty string for empty input', () => {
    expect(classifyFiles('')).toBe('');
  });

  it('returns empty string when all entries are filtered out', () => {
    const status = [
      ' D removed.ts',
      '?? nested/',
    ].join('\n');
    expect(classifyFiles(status)).toBe('');
  });

  it('handles renamed files as M', () => {
    // git status --short shows renames as "R " with the new path
    const status = 'R  src/old.ts -> src/new.ts';
    expect(classifyFiles(status)).toBe('M src/old.ts -> src/new.ts');
  });
});
