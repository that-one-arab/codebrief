import { FileSummary } from '../types';

const METADATA_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    changesAuthoredByAi: { type: 'boolean' },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          fileCount: { type: 'number' },
          estimatedLines: { type: 'number' }
        },
        required: ['id', 'title', 'files']
      }
    }
  },
  required: ['title', 'groups', 'changesAuthoredByAi']
};

const GROUP_SCHEMA = {
  type: 'object',
  properties: {
    groupIndex: { type: 'number' },
    groupId: { type: 'string' },
    title: { type: 'string' },
    explanation: { type: 'string' },
    changesAuthoredByAi: { type: 'boolean' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          hunks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                oldStart: { type: 'number' },
                oldLines: { type: 'number' },
                newStart: { type: 'number' },
                newLines: { type: 'number' }
              },
              required: ['oldStart', 'oldLines', 'newStart', 'newLines']
            }
          }
        },
        required: ['path', 'hunks']
      }
    }
  },
  required: ['groupIndex', 'groupId', 'title', 'explanation', 'files']
};

const COMMIT_MESSAGE_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string' }
  },
  required: ['message']
};

export function buildGroupingPrompt(
  files: FileSummary[],
  recentCommits: string,
  outputDir: string
): string {
  const fileLines = files.map(f => {
    const stats = `hunks=${f.hunks} +${f.additions} -${f.deletions}`;
    return `${f.path} | ${stats}`;
  }).join('\n');

  return `You are part of a tool that groups code changes for review.

We are running a two-pass review:
1) Group files by logical intent.
2) Provide detailed group explanations later (diff hunks will be supplied in pass 2).

## Step 1 (Metadata - Grouping Only)

Write \`${outputDir}/metadata.json\` with the group structure.

Rules:
- Every file must appear in exactly one group.
- Only use the file paths listed below.
- Use kebab-case for group IDs.
- Set \`changesAuthoredByAi\` to true only if you personally authored these changes in this session. Otherwise, set it to false.

Schema:
\`\`\`json
${JSON.stringify(METADATA_SCHEMA, null, 2)}
\`\`\`

Files (path | stats):
\`\`\`
${fileLines}
\`\`\`

Recent commits (for commit style context only):
\`\`\`
${recentCommits}
\`\`\`

Important:
- Do not use tools.
- Do not infer file paths not listed above.`;
}

export function buildGroupPrompt(params: {
  groupIndex: number;
  groupId: string;
  title: string;
  changesAuthoredByAi: boolean;
  hunkMap: Array<{ path: string; hunks: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number }> }>;
  diffText: string;
  diffMode: 'full' | 'summary';
  outputDir: string;
}): string {
  const {
    groupIndex,
    groupId,
    title,
    changesAuthoredByAi,
    hunkMap,
    diffText,
    diffMode,
    outputDir
  } = params;

  const diffLabel = diffMode === 'full' ? 'Full diff' : 'Summarized diff (some lines omitted)';

  return `You are part of a tool that writes one review group at a time.

## Group Info
- Index: ${groupIndex}
- ID: ${groupId}
- Title: ${title}
- changesAuthoredByAi: ${changesAuthoredByAi}

## Required Hunks (use EXACTLY as provided)
\`\`\`json
${JSON.stringify(hunkMap, null, 2)}
\`\`\`

## ${diffLabel}
\`\`\`diff
${diffText}
\`\`\`

## Output
Write \`${outputDir}/group-${groupIndex}-${groupId}.json\` using this schema:
\`\`\`json
${JSON.stringify(GROUP_SCHEMA, null, 2)}
\`\`\`

Notes:
- Use the required hunks list exactly. Do not add or remove hunks.
- Explanation should be concise and useful to an engineer reviewing the change.
- If \`changesAuthoredByAi\` is false, explain in neutral/third person and mark intent as assumed if you infer it.`;
}

export function buildCommitMessagePrompt(params: {
  title: string;
  groups: Array<{ id: string; title: string; files: string[] }>;
  recentCommits: string;
  outputDir: string;
}): string {
  const { title, groups, recentCommits, outputDir } = params;
  const groupLines = groups.map(group => {
    const files = group.files.length > 0 ? group.files.join(', ') : '(no files)';
    return `${group.title} [${group.id}]: ${files}`;
  }).join('\n');

  return `Write a commit message for the reviewed changes.

Review title: ${title}

Groups:
\`\`\`
${groupLines}
\`\`\`

Recent commits (style reference):
\`\`\`
${recentCommits}
\`\`\`

Write \`${outputDir}/commit-message.json\` following this schema:
\`\`\`json
${JSON.stringify(COMMIT_MESSAGE_SCHEMA, null, 2)}
\`\`\`

Notes:
- Keep it concise and descriptive.
- Use the commit style suggested by recent commits if obvious.`;
}
