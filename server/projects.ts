import { all, get, id, insert, now, patch, run } from './db.ts';
import { publish } from './bus.ts';

export interface Project {
  id: string;
  name: string;
  description: string;
  instructions: string;
  notes: string;
  emoji: string;
  archived: number;
  created_at: number;
  updated_at: number;
}

export interface ProjectTask {
  id: string;
  project_id: string;
  title: string;
  done: number;
  due: string | null;
  created_at: number;
}

export function listProjects() {
  return all<Project & { open_tasks: number; chats: number }>(
    `SELECT p.*,
       (SELECT COUNT(*) FROM project_tasks t WHERE t.project_id = p.id AND t.done = 0) AS open_tasks,
       (SELECT COUNT(*) FROM conversations c WHERE c.project_id = p.id) AS chats
     FROM projects p WHERE archived = 0 ORDER BY updated_at DESC`,
  );
}

export function getProject(pid: string) {
  const p = get<Project>('SELECT * FROM projects WHERE id = ?', pid);
  if (!p) return undefined;
  return {
    ...p,
    tasks: all<ProjectTask>('SELECT * FROM project_tasks WHERE project_id = ? ORDER BY done, created_at', pid),
    conversations: all('SELECT id, title, updated_at FROM conversations WHERE project_id = ? ORDER BY updated_at DESC', pid),
    files: all('SELECT id, name, length(text) AS chars, created_at FROM project_files WHERE project_id = ? ORDER BY created_at', pid),
  };
}

export function findProject(nameOrId: string) {
  return (
    get<Project>('SELECT * FROM projects WHERE id = ?', nameOrId) ??
    get<Project>('SELECT * FROM projects WHERE lower(name) = lower(?)', nameOrId) ??
    get<Project>("SELECT * FROM projects WHERE lower(name) LIKE '%' || lower(?) || '%' ORDER BY updated_at DESC", nameOrId)
  );
}

export function createProject(input: { name: string; description?: string; instructions?: string; emoji?: string }) {
  const pid = id();
  insert('projects', {
    id: pid,
    name: input.name,
    description: input.description ?? '',
    instructions: input.instructions ?? '',
    notes: '',
    emoji: input.emoji ?? '📁',
    archived: 0,
    created_at: now(),
    updated_at: now(),
  });
  publish({ type: 'projects.updated' });
  return pid;
}

export function updateProject(pid: string, changes: Partial<Pick<Project, 'name' | 'description' | 'instructions' | 'notes' | 'emoji' | 'archived'>>) {
  patch('projects', pid, { ...changes, updated_at: now() }, ['name', 'description', 'instructions', 'notes', 'emoji', 'archived', 'updated_at']);
  publish({ type: 'projects.updated', id: pid });
}

export function deleteProject(pid: string) {
  run('DELETE FROM projects WHERE id = ?', pid);
  publish({ type: 'projects.updated' });
}

export function addTask(pid: string, title: string, due?: string) {
  const tid = id();
  insert('project_tasks', { id: tid, project_id: pid, title, done: 0, due: due ?? null, created_at: now() });
  updateProject(pid, {});
  return tid;
}

export function updateTask(tid: string, changes: { title?: string; done?: boolean; due?: string | null }) {
  const t = get<ProjectTask>('SELECT * FROM project_tasks WHERE id = ?', tid);
  if (!t) return;
  patch('project_tasks', tid, { title: changes.title, due: changes.due, done: changes.done === undefined ? undefined : changes.done ? 1 : 0 }, [
    'title',
    'due',
    'done',
  ]);
  updateProject(t.project_id, {});
}

export function deleteTask(tid: string) {
  const t = get<ProjectTask>('SELECT * FROM project_tasks WHERE id = ?', tid);
  run('DELETE FROM project_tasks WHERE id = ?', tid);
  if (t) updateProject(t.project_id, {});
}

/** Documents attached to a project become part of its context (text only, extracted on upload). */
export async function addProjectFile(pid: string, file: { name: string; mediaType: string; data: string }) {
  const buf = Buffer.from(file.data, 'base64');
  let text: string;
  if (file.mediaType === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    const { extractText, getDocumentProxy } = await import('unpdf');
    text = (await extractText(await getDocumentProxy(new Uint8Array(buf)), { mergePages: true })).text as string;
  } else if (/^text\/|json|xml|csv|markdown/.test(file.mediaType) || /\.(md|txt|csv|json|html?)$/i.test(file.name)) {
    text = buf.toString('utf8');
  } else throw new Error('Only PDFs and text files can be added to a project.');
  const fid = id();
  insert('project_files', { id: fid, project_id: pid, name: file.name, text: text.slice(0, 200_000), created_at: now() });
  updateProject(pid, {});
  return fid;
}

export function deleteProjectFile(fid: string) {
  const f = get<{ project_id: string }>('SELECT project_id FROM project_files WHERE id = ?', fid);
  run('DELETE FROM project_files WHERE id = ?', fid);
  if (f) updateProject(f.project_id, {});
}

export function projectContext(pid: string): string {
  const p = getProject(pid);
  if (!p) return '';
  const open = p.tasks.filter((t) => !t.done);
  const done = p.tasks.filter((t) => t.done);
  return `You are working inside the project "${p.name}" (id ${p.id}).
${p.description ? `Description: ${p.description}\n` : ''}${p.instructions ? `Project instructions: ${p.instructions}\n` : ''}
Project notes (your shared working document, keep it current with project_update_notes):
${p.notes || '(empty)'}

Open tasks:
${open.map((t) => `- [ ] ${t.title}${t.due ? ` (due ${t.due})` : ''} (task id ${t.id.slice(0, 8)})`).join('\n') || '(none)'}
${done.length ? `Completed: ${done.map((t) => t.title).join('; ')}` : ''}${projectDocs(pid)}`;
}

function projectDocs(pid: string) {
  const files = all<{ name: string; text: string }>('SELECT name, text FROM project_files WHERE project_id = ? ORDER BY created_at', pid);
  if (!files.length) return '';
  let budget = 30_000;
  const parts = files.map((f) => {
    const take = f.text.slice(0, Math.max(0, Math.min(budget, 12_000)));
    budget -= take.length;
    return `--- ${f.name} ---\n${take}${take.length < f.text.length ? '\n[truncated]' : ''}`;
  });
  return `\n\nProject documents (provided by the user):\n${parts.join('\n\n')}`;
}
