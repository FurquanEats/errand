import { tool } from 'ai';
import { z } from 'zod';
import { addMemory, CATEGORIES, deleteMemory, listMemories, searchMemories, updateMemory } from '../memory.ts';

export const memoryTools = () => ({
  memory_save: tool({
    description: 'Remember a durable fact about the user (preferences, people, addresses, routines). Not for secrets.',
    inputSchema: z.object({ content: z.string(), category: z.enum(CATEGORIES as [string, ...string[]]).default('general') }),
    execute: async ({ content, category }) => ({ saved: addMemory(content, category, 'chat') }),
  }),
  specialty_save: tool({
    description:
      'Save a specialty: the user’s own way of doing a repeatable multi-step task (how returns should be negotiated, how a weekly report is put together). ' +
      'Use it when the user explains such a procedure or corrects how you did one. To change a specialty later, use memory_update with its id.',
    inputSchema: z.object({
      name: z.string().describe('short, e.g. "Product returns"'),
      when: z.string().describe('when it applies'),
      steps: z.array(z.string()).min(1),
    }),
    execute: async ({ name, when, steps }) => ({
      saved: addMemory(`${name} (when ${when}): ${steps.map((s, i) => `${i + 1}) ${s}`).join(' ')}`, 'specialty', 'chat'),
    }),
  }),
  memory_search: tool({
    description: 'Search long-term memory.',
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }) => searchMemories(query).map((m) => ({ id: m.id.slice(0, 8), category: m.category, content: m.content })),
  }),
  memory_update: tool({
    description: 'Correct or delete a memory by its id prefix (shown as id:xxxxxxxx).',
    inputSchema: z.object({ id: z.string(), content: z.string().optional().describe('omit to delete') }),
    execute: async ({ id, content }) => {
      const m = listMemories().find((x) => x.id.startsWith(id));
      if (!m) return { error: 'not found' };
      if (content) updateMemory(m.id, { content });
      else deleteMemory(m.id);
      return { ok: true };
    },
  }),
});
