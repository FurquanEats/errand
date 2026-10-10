import { useState } from 'react';
import { TaskLine } from './HandoffView';
import { Icon } from './Icon';
import { useApp } from '../context';

/** Friendly, past-tense labels for tool activity in the chat. */
const LABELS: Record<string, string> = {
  web_search: 'Searched the web',
  fetch_url: 'Read a page',
  weather_forecast: 'Checked the forecast',
  api_request: 'Called an API',
  memory_save: 'Remembered',
  memory_search: 'Checked memory',
  memory_update: 'Updated memory',
  handoff: 'Browser task',
  email_search: 'Searched email',
  email_read: 'Read an email',
  email_send: 'Email',
  email_send_many: 'Emails',
  email_mark_read: 'Marked read',
  email_folders: 'Checked folders',
  email_move: 'Filed an email',
  email_flag: 'Flagged an email',
  email_senders: 'Scanned the inbox',
  email_cleanup: 'Cleaned up email',
  email_unsubscribe: 'Unsubscribed',
  email_filter: 'Created a filter',
  calendar_events: 'Checked calendar',
  calendar_create_event: 'Calendar event',
  calendar_invite: 'Calendar invite',
  calendar_add_feed: 'Added a calendar',
  drive_search: 'Searched Drive',
  drive_read: 'Read from Drive',
  project_create: 'Created a project',
  project_add_task: 'Added a task',
  project_complete_task: 'Completed a task',
  project_update_notes: 'Updated project notes',
  project_list: 'Checked projects',
  action_button_create: 'Pinned to Home',
  action_button_update: 'Updated Home',
  panel_list: 'Checked panels',
  panel_update: 'Updated a panel',
  routine_update: 'Updated a routine',
  model_choose: 'AI models',
  specialty_save: 'Saved a specialty',
  panel_create: 'Built a panel',
  routine_create: 'Scheduled',
  routine_list: 'Checked routines',
  vault_list: 'Checked vault',
  files_list: 'Listed files',
  files_read: 'Read a file',
  files_search: 'Searched files',
  files_write: 'Wrote a file',
  folder_share: 'Shared a folder',
  settings_update: 'Updated settings',
  connect_account: 'Connect',
  integration_add: 'Added an integration',
  usage_stats: 'Looked at usage',
  make_presentation: 'Made a presentation',
  save_file: 'Saved a file',
  run_command: 'Ran a command',
};

function summary(input: any): string {
  if (!input || typeof input !== 'object') return '';
  return String(
    input.query ??
      input.url ??
      input.goal ??
      input.title ??
      input.subject ??
      input.description ??
      input.content ??
      input.path ??
      input.name ??
      input.to ??
      input.command ??
      input.summary ??
      '',
  ).slice(0, 140);
}

export function unwrapOutput(output: any) {
  if (output && typeof output === 'object' && 'type' in output && 'value' in output) return output.value;
  return output;
}

interface FileRef {
  name: string;
  url: string;
  mime?: string;
}

function ActionLink({ action }: { action: { label: string; url: string; note?: string } }) {
  const { phone } = useApp();
  const signIn = action.url.startsWith('/api/oauth/');
  if (signIn && phone) return <span className="hint">{action.label}: open Errand on your computer to sign in.</span>;
  // Sign-ins return to Errand by themselves, so they stay in this tab; files and websites open a new one.
  const external = (action.url.startsWith('/api/') && !signIn) || /^https?:/.test(action.url);
  return (
    <div className="stack" style={{ gap: 6, justifyItems: 'start' }}>
      <a className="action-link" href={action.url} target={external ? '_blank' : undefined} rel="noreferrer">
        {action.label} <Icon name="arrowRight" size={14} />
      </a>
      {action.note && <span className="hint">{action.note}</span>}
    </div>
  );
}

function Files({ files }: { files: FileRef[] }) {
  return (
    <div className="files">
      {files.map((f) =>
        /\.(png|jpe?g)$/i.test(f.name) ? (
          <a key={f.url} href={f.url} target="_blank" rel="noreferrer">
            <img src={f.url} alt={f.name} />
          </a>
        ) : (
          <a key={f.url} className="file-tag" href={f.url} target="_blank" rel="noreferrer">
            <Icon name="clip" size={13} /> {f.name}
          </a>
        ),
      )}
    </div>
  );
}

export function ToolCard({
  name,
  input,
  output,
  error,
  handoffId,
  pending,
}: {
  name: string;
  input: any;
  output?: any;
  error?: string;
  handoffId?: string;
  pending?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const out = unwrapOutput(output);
  const hid = handoffId ?? out?.handoff_id;
  const files: FileRef[] = out?.files ?? (out?.file ? [out.file] : []);

  if (name === 'handoff' && hid) {
    return (
      <div className="stack" style={{ gap: 8 }}>
        <TaskLine id={hid} />
        {files.length > 0 && <Files files={files} />}
      </div>
    );
  }
  if (out?.action?.url) return <ActionLink action={out.action} />;

  const label = LABELS[name] ?? (name.startsWith('mcp_') ? name.replace(/^mcp_/, '').replace(/_/g, ' ') : name.replace(/_/g, ' '));
  const running = pending && out === undefined && !error;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className={`tool ${open ? 'open' : ''}`}>
        <div
          className="tool-head"
          onClick={() => setOpen(!open)}
          role="button"
          tabIndex={0}
          aria-expanded={open}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpen(!open))}
        >
          <span className={`tdot ${running ? 'run' : error ? 'err' : ''}`} />
          <span className="name">{label}</span>
          <span className="sum">{summary(input)}</span>
        </div>
        {open && (
          <div className="tool-body">
            <pre>{JSON.stringify(input, null, 2)}</pre>
            {(out !== undefined || error) && <pre>{error ?? (typeof out === 'string' ? out : JSON.stringify(out, null, 2))}</pre>}
          </div>
        )}
      </div>
      {files.length > 0 && <Files files={files} />}
    </div>
  );
}
