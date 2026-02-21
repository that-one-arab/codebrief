import { GitContext } from '../types';

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
          fileCount: { type: 'number' },
          estimatedLines: { type: 'number' }
        },
        required: ['id', 'title']
      }
    }
  },
  required: ['title', 'groups', 'changesAuthoredByAi']
};

const COMMIT_MESSAGE_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string' }
  },
  required: ['message']
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

export function buildStreamingPrompt(git: GitContext, outputDir: string): string {
  return `You are now currently part of a programmatic tool. The purpose of this tool is to help review code.

The problem statement is: code reviews are hard because git diffs are displayed in an alphabetical way ordered by file name.

To address this, you will structure the changes into groups, where each group is logically connected.

## Step 1 (Metadata)

For this part, you will produce a \`${outputDir}/metadata.json\` file.

First we must accurately determine whether the code changes (the git diff) were made by you. You can achieve that by examining the git diff below and comparing the diff with the code changes you did in this session and update the \`changesAuthoredByAi\` flag accordingly.

Then, analyze the changes and identify the titles of the logically connected groups.

Then suggest a title for the review based on the group titles.

Finally, write the metadata file with the \`changesAuthoredByAi\` flag, review title, and group titles. Follow this JSON schema:

\`\`\`json
${JSON.stringify(METADATA_SCHEMA, null, 2)}
\`\`\`

Notes:
- Use kebab-case for group IDs (e.g., "add-user-authentication")

## Step 2 (Groups Data)

For each group title, generate group content ONE AT A TIME.

For each group:

- Assign code hunks to the group and write an explanation for the group. Follow this JSON schema:
\`\`\`json
${JSON.stringify(GROUP_SCHEMA, null, 2)}
\`\`\`

- IMMEDIATELY write the JSON object to a file in the directory: \`${outputDir}\`. Use the filename format: \`group-{groupIndex}-{groupId}.json\` (example: \`group-0-introduce-error-handling.json\`)

- Only proceed to the next group AFTER the file has been written.

Notes:
- A group explanation is structured as "Summary" followed by "Intent".
    - If \`changesAuthoredByAi\` is true, this means you understand the intent of the changes because you made them yourself. You must explain your intent clearly, writing in first person ("I added...", "I refactored...").
    - If \`changesAuthoredByAi\` is false then only provide a brief summary in neutral/third person ("This change adds...", "The update refactors...").
    - You can guess the intent of the changes if \`changesAuthoredByAi\` is false, but do NOT make it seem like you know the intent for a fact, highlight that you are assuming the intent.
- List all files and hunks relevant to this group.
- The groupId in the JSON must match the groupId in the filename exactly.

## Step 3 (Commit Message)

AFTER ALL groups have been written, generate and write a commit message to \`${outputDir}/commit-message.json\`.

Follow this JSON schema:
\`\`\`json
${JSON.stringify(COMMIT_MESSAGE_SCHEMA, null, 2)}
\`\`\`

Notes:
- Write a concise but descriptive commit message suitable for git
- The message should capture the overall intent of all changes
- Can be multiline
- following codebase commit format is encouraged (determine that from the recent commits attached in the context)

# CONTEXT

**Files Changed:**
${git.filesChanged.join('\n')}

**Git Diff:**

\`\`\`diff
${git.diff}
\`\`\`

**Recent commits:**
\`\`\`
${git.recentCommits}
\`\`\`

# Important Notes

- Do not use tools for the purpose of gaining additional context (eg: inspecting directories, reading files, etc.), you have all the context you need already.
- Write the metadata file FIRST, before any group files.
- Write exactly N group JSON files where N = number of groups in metadata.
- Each file should contain a single valid JSON object (not wrapped in an array).
- Write each file immediately after completing that group (don't wait for all groups).
- For explanations, based on your own judgement, you can use a combination of markdown text, lists or anything other text form to increase its quality, but make sure the explanation is streamlined and concise. A good mental model to follow is imagining yourself as a software engineer explaining code changes to a fellow software engineer.
- Make sure to assign ALL the code hunks in the diff to the groups data.`
}
