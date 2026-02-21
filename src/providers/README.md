# AI Review Providers

Abstraction layer for AI backends. Each provider implements `ReviewProvider` — handling prompt construction, AI invocation, and output parsing internally — and delivers results through a unified callback contract.

## Interface

```typescript
interface ReviewProvider {
  readonly id: string;
  readonly name: string;

  generateReview(
    git: GitContext,
    workspaceRoot: string,
    onGroup: (result: StreamingGroupResult) => void | Promise<void>,
    onMetadata: (result: StreamingMetadataResult) => void | Promise<void>,
  ): Promise<void>;
}
```

**Input**: `GitContext` — parsed diff, file list, branch, status.

**Output**: Two callbacks that the provider must call:
- `onMetadata` — once, with review title and group list
- `onGroup` — once per group, with explanation + file/hunk references

The provider owns everything between input and output: prompt format, transport mechanism, response parsing.

## Existing Provider
### `ClaudeCodeProvider` (`claudeCode.ts`)

Spawns the Claude Code CLI as a child process. Claude writes JSON files to a temp directory; the provider polls for them.

**Transport**: CLI spawn + file system polling (500ms interval)

**Flow**:
1. Creates temp directory
2. Builds prompt with JSON schemas and file-write instructions
3. Spawns `claude --fork-session -p <prompt> --allowedTools Write`
4. Polls temp dir for `metadata.json` → calls `onMetadata`
5. Polls for `group-{index}-{id}.json` files → calls `onGroup` per file
6. Resolves when CLI exits

### `OpenCodeProvider` (`opencode.ts`)

Communicates with an OpenCode HTTP server. Uses the same temp-directory file-writing approach as Claude Code — the AI writes JSON files, and the provider polls for them.

**Transport**: HTTP API + file system polling (500ms interval)

**Flow**:
1. Probes port 4096 for an existing opencode server
2. If not found, starts `opencode serve` and waits for it to become responsive
3. Checks for existing sessions — if found, forks the most recent one (preserves AI context); otherwise creates a new session
4. Creates temp directory, sends structured prompt via `POST /session/{id}/message`
5. Polls temp dir for `metadata.json` → calls `onMetadata`
6. Polls for `group-{index}-{id}.json` files → calls `onGroup` per file
7. Cleans up: deletes the session, kills the server if it was started by the provider

Typically we prefer forking an existing session.

**Why fork?** If the user used an AI agent (via claude code, opencode, etc...) to generate the code changes, forking that session preserves the original conversation context. This gives the review AI full knowledge of *why* changes were made, producing more accurate reviews.

### `CodexProvider` (`codex.ts`)

Communicates with the Codex app-server over JSON-RPC (stdio). Uses the same temp-directory file-writing approach as the other providers.

**Transport**: `codex app-server` (JSON-RPC over stdio) + file system polling (500ms interval)

**Flow**:
1. Spawns `codex app-server` and completes `initialize`/`initialized` handshake
2. Finds the workspace base thread id from `.ai-review-codex-thread.json`
3. If missing, creates a new base thread and stores the id
4. Forks the base thread for this run
5. Creates temp directory, sends prompt via `turn/start`
6. Polls temp dir for `metadata.json` → calls `onMetadata`
7. Polls for `group-{index}-{id}.json` files → calls `onGroup` per file
8. Archives the forked thread and cleans up temp directory

## Adding a Provider

1. Create `src/providers/myProvider.ts`
2. Implement `ReviewProvider`
3. Export from `index.ts`
4. Update `getProvider()` to return your provider (or add selection logic)

Example skeleton:

```typescript
import { ReviewProvider } from './provider';
import { GitContext, StreamingGroupResult, StreamingMetadataResult } from '../types';

export class MyProvider implements ReviewProvider {
  readonly id = 'my-provider';
  readonly name = 'My Provider';

  async generateReview(
    git: GitContext,
    workspaceRoot: string,
    onGroup: (result: StreamingGroupResult) => void | Promise<void>,
    onMetadata: (result: StreamingMetadataResult) => void | Promise<void>,
  ): Promise<void> {
    // 1. Build your prompt/request from git context
    // 2. Call your AI backend (HTTP API, CLI, local model, etc.)
    // 3. Parse response and call onMetadata once, then onGroup for each group
  }
}
```

The `StreamingMetadataResult` and `StreamingGroupResult` types are defined in `src/types/index.ts`.
