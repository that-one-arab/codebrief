# Codebrief - Agent Guide

This document contains technical details for AI agents working on this codebase.

## Architecture Overview

### How It Works

```
git diff (unstaged) → AI provider analyzes changes
                     → streams metadata (title + group list)
                     → streams each group (explanation + file/hunk references)
                     → extension merges hunk metadata with local diff lines
                     → webview renders grouped, syntax-highlighted review
```

Claude only returns hunk coordinates (line numbers). Actual line content comes from `git diff` locally, saving ~80% of output tokens.

## Project Structure

```
src/
├── extension.ts              Entry point, activates ReviewManager
├── reviewManager.ts          Registers commands, tree views, URI handler
├── reviewGenerator.ts        Orchestrates generation: git context → provider → store → UI
├── providers/                AI provider abstraction (see providers/README.md)
│   ├── provider.ts           ReviewProvider interface
│   ├── claudeCode.ts         Claude Code CLI implementation
│   ├── opencode.ts           OpenCode HTTP server implementation
│   └── index.ts              getProvider() factory
├── services/
│   └── gitService.ts         Git context: diff, status, branch, parsed hunks
├── views/
│   ├── reviewPanel.ts        Webview panel (streaming updates, syntax highlighting)
│   ├── intentReviewProvider.ts  TreeDataProvider for groups sidebar
│   ├── stagedChangesProvider.ts TreeDataProvider for staged files sidebar
│   ├── reviewStore.ts        EventEmitter store — single source of truth for review state
│   ├── treeItems.ts          TreeItem classes (IntentGroup, FileChange)
│   ├── groupMapping.ts       File → group mapping
│   └── stagingState.ts       Staging state tracking
├── utils/
│   ├── diffParser.ts         Unified diff → DiffFile[] parser
│   ├── highlighter.ts        TextMate tokenization (vscode-textmate + oniguruma)
│   ├── reviewMerger.ts       Merge AI group output with parsed diff lines
│   └── logger.ts             File + output channel logger with rotation & tracing
└── types/
    └── index.ts              All shared type definitions
```

## Data Flow

1. `reviewGenerator` gets `GitContext` from `gitService` (diff, parsed hunks, files changed)
2. Calls `provider.generateReview(git, workspaceRoot, ongroup, onMetadata)`
3. Provider streams callbacks → `reviewStore` accumulates state and emits events
4. `reviewPanel` subscribes to store events → tokenizes + renders each group as it arrives
5. `intentReviewProvider` updates sidebar tree as groups stream in

## Log Directory Structure

```
logs/
└── 2024-01-15-10-23-45/                      # VS Code session directory
    ├── codebrief.log                    # Main log file for this session
    └── analysis/                             # Analysis outputs
        ├── 10-23-45/                         # Review at 10:23:45
        │   ├── metadata.json
        │   ├── group-0-auth.json
        │   └── group-1-ui.json
        ├── 11-15-22/                         # Review at 11:15:22
        │   ├── metadata.json
        │   ├── group-0-refactor.json
        │   └── group-1-tests.json
        └── ...
```

### Log Features

- **Session-based**: Each VS Code session gets its own timestamped directory
- **Analysis grouping**: Each code review gets a timestamped subdirectory under `analysis/`
- **Session rotation**: Keeps last 10 VS Code sessions
- **Persistent**: Logs survive VS Code crashes and restarts
- **Structured**: Each log entry includes component, operation ID, and context
- **JSON Preservation**: AI-written JSON files are preserved per analysis
