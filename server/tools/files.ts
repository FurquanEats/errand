import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { filesEnabled, listDir, readFile, searchFiles, writeFile } from '../connectors/files.ts';
import { requestApproval } from '../approvals.ts';
import type { ToolContext } from './index.ts';

/** Files inside the folders the user has shared in Settings. */
export function fileTools(ctx: ToolContext): ToolSet {
  if (!filesEnabled()) return {};
  return {
    files_list: tool({
      description: 'List a shared folder. Empty path lists the shared roots.',
      inputSchema: z.object({ path: z.string().default('') }),
      execute: async ({ path }) => listDir(path),
    }),
    files_read: tool({
      description: 'Read a text file from the shared folders.',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => readFile(path),
    }),
    files_search: tool({
      description: 'Find files by name in the shared folders.',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => searchFiles(query),
    }),
    files_write: tool({
      description: 'Write a text file in the shared folders (asks the user first).',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => {
        const ok = await requestApproval(
          { title: 'Write this file?', detail: `${path}\n\n${content.slice(0, 1500)}`, conversationId: ctx.conversationId },
          ctx.signal,
        );
        return ok ? writeFile(path, content) : { written: false };
      },
    }),
  };
}
