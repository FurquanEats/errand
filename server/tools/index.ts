import type { ToolSet } from 'ai';
import { mcpTools } from '../connectors/mcp.ts';
import { redactSecrets } from '../security.ts';
import { memoryTools } from './memory.ts';
import { webTools } from './web.ts';
import { organizeTools } from './organize.ts';
import { emailTools } from './email.ts';
import { calendarTools } from './calendar.ts';
import { fileTools } from './files.ts';
import { handoffTools } from './handoff.ts';
import { settingsTools } from './settings.ts';
import { createTools } from './create.ts';

export interface ToolContext {
  conversationId?: string;
  projectId?: string | null;
  signal?: AbortSignal;
  /** Called when a handoff starts so the UI can show the live browser inline. */
  onHandoff?: (id: string) => void;
  /** Unattended runs (panel refreshes) only get tools that read. */
  readOnly?: boolean;
}

const READ_ONLY =
  /^(web_search|weather_forecast|fetch_url|api_request|memory_search|email_search|email_read|email_folders|email_senders|calendar_events|drive_search|drive_read|files_list|files_read|files_search|project_list|routine_list|usage_stats|tracker_list|spending|mcp_)/;

/** Everything the assistant can do. Tools with real-world side effects ask for approval first. */
export function buildTools(ctx: ToolContext): ToolSet {
  const tools: ToolSet = {
    ...memoryTools(),
    ...webTools(ctx),
    ...organizeTools(ctx),
    ...emailTools(ctx),
    ...calendarTools(ctx),
    ...fileTools(ctx),
    ...handoffTools(ctx),
    ...settingsTools(ctx),
    ...createTools(ctx),
    ...mcpTools({ conversationId: ctx.conversationId, signal: ctx.signal, unattended: ctx.readOnly }),
  };
  if (ctx.readOnly) for (const name of Object.keys(tools)) if (!READ_ONLY.test(name)) delete tools[name];
  for (const t of Object.values(tools)) {
    const run = t.execute;
    if (run) t.execute = async (input: any, options: any) => redactSecrets(await run(input, options));
  }
  return tools;
}
