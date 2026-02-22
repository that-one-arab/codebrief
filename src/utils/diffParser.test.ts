import { describe, it, expect } from 'vitest';
import { parseDiff } from './diffParser';

describe('parseDiff', () => {
  it('parses new untracked file diff from /dev/null', () => {
    const diff = [
      'diff --git a/dev/null b/PW-PLAN.md',
      'new file mode 100644',
      'index 0000000..e69de29',
      '--- /dev/null',
      '+++ b/PW-PLAN.md',
      '@@ -0,0 +1,2 @@',
      '+line1',
      '+line2',
      ''
    ].join('\n');

    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('PW-PLAN.md');
    expect(files[0].hunks).toHaveLength(1);
  });

  it('parses quoted paths with spaces for new files', () => {
    const diff = [
      'diff --git "a/dev/null" "b/Docs/Auth Plan.md"',
      'new file mode 100644',
      '--- "/dev/null"',
      '+++ "b/Docs/Auth Plan.md"',
      '@@ -0,0 +1 @@',
      '+hello',
      ''
    ].join('\n');

    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('Docs/Auth Plan.md');
  });

  it('handles no-prefix diffs by falling back to +++ header', () => {
    const diff = [
      'diff --git old/path.txt new/path.txt',
      'index 1234567..89abcde 100644',
      '--- old/path.txt',
      '+++ new/path.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      ''
    ].join('\n');

    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('new/path.txt');
    expect(files[0].oldPath).toBe('old/path.txt');
  });

  it('falls back to quoted +++ header when diff --git is unparseable', () => {
    const diff = [
      'diff --git dev/null "b/Docs/Auth Plan.md"',
      'new file mode 100644',
      '--- "/dev/null"',
      '+++ "b/Docs/Auth Plan.md"',
      '@@ -0,0 +1 @@',
      '+hello',
      ''
    ].join('\n');

    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('Docs/Auth Plan.md');
  });

  it('parses renamed files and preserves oldPath', () => {
    const diff = [
      'diff --git a/old.txt b/new.txt',
      'similarity index 100%',
      'rename from old.txt',
      'rename to new.txt',
      '--- a/old.txt',
      '+++ b/new.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      ''
    ].join('\n');

    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('new.txt');
    expect(files[0].oldPath).toBe('old.txt');
  });

  it('parses deleted files with /dev/null destination', () => {
    const diff = [
      'diff --git a/obsolete.txt b/obsolete.txt',
      'deleted file mode 100644',
      '--- a/obsolete.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-old',
      ''
    ].join('\n');

    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('obsolete.txt');
  });

  it('unquotes and unescapes git paths', () => {
    const diff = [
      'diff --git "a/Weird\\tName.md" "b/Weird\\tName.md"',
      'index 1234567..89abcde 100644',
      '--- "a/Weird\\tName.md"',
      '+++ "b/Weird\\tName.md"',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      ''
    ].join('\n');

    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('Weird\tName.md');
  });

  it('parses multiple files in a single diff', () => {
    const diff = [
      'diff --git a/file1.txt b/file1.txt',
      'index 1234567..89abcde 100644',
      '--- a/file1.txt',
      '+++ b/file1.txt',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/file2.txt b/file2.txt',
      'index 1234567..89abcde 100644',
      '--- a/file2.txt',
      '+++ b/file2.txt',
      '@@ -1 +1 @@',
      '-c',
      '+d',
      ''
    ].join('\n');

    const files = parseDiff(diff);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe('file1.txt');
    expect(files[1].path).toBe('file2.txt');
  });

  it('ignores malformed diffs without file headers', () => {
    const diff = [
      '@@ -1 +1 @@',
      '-a',
      '+b',
      ''
    ].join('\n');

    const files = parseDiff(diff);
    expect(files).toHaveLength(0);
  });
});
