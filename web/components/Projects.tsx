import { useEffect, useState } from 'react';
import { api, fileToAttachment, navigate, timeAgo, useResource } from '../api';
import { useApp } from '../context';
import { Composer, type Attachment } from './Composer';
import { Markdown } from './Markdown';
import { Icon } from './Icon';

interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  emoji: string;
  open_tasks: number;
  chats: number;
  updated_at: number;
}

interface Project extends ProjectSummary {
  instructions: string;
  notes: string;
  tasks: { id: string; title: string; done: number; due: string | null }[];
  conversations: { id: string; title: string; updated_at: number }[];
  files: { id: string; name: string; chars: number }[];
}

export function ProjectList() {
  const { data } = useResource<ProjectSummary[]>('/projects', ['projects.updated', 'conversations.updated']);
  const [name, setName] = useState('');

  const create = async () => {
    if (!name.trim()) return;
    const { id } = await api('/projects', { body: { name } });
    setName('');
    navigate(`/projects/${id}`);
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Projects</h1>
      </div>
      <p className="lede">
        For bigger things that take more than one conversation: a job search, a move, a trip. Errand keeps notes and tasks here and works on them with you.
      </p>
      <form
        className="row"
        style={{ marginBottom: 28 }}
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input className="input grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="New project name, e.g. “Find a new apartment”" />
        <button className="btn primary" disabled={!name.trim()}>
          <Icon name="plus" size={16} /> Create
        </button>
      </form>
      {data && !data.length && (
        <div className="empty">
          <div className="big">No projects yet</div>Create one above, or say “make this a project” in any chat.
        </div>
      )}
      <div className="grid3">
        {data?.map((p) => (
          <a key={p.id} href={`#/projects/${p.id}`} className="card project-card rise">
            <div className="emoji">{p.emoji}</div>
            <div className="name">{p.name}</div>
            {p.description && <div className="small muted">{p.description}</div>}
            <div className="meta">
              {p.open_tasks} open · {p.chats} chats · {timeAgo(p.updated_at)}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

export function ProjectDetail({ id }: { id: string }) {
  const { toast } = useApp();
  const { data: p } = useResource<Project>(`/projects/${id}`, ['projects.updated', 'conversations.updated']);
  const [task, setTask] = useState('');
  const [editingNotes, setEditingNotes] = useState(false);
  const [notes, setNotes] = useState('');
  const [tab, setTab] = useState<'overview' | 'settings'>('overview');
  const [meta, setMeta] = useState({ name: '', description: '', instructions: '', emoji: '' });

  useEffect(() => {
    if (p) setMeta({ name: p.name, description: p.description, instructions: p.instructions, emoji: p.emoji });
  }, [p?.id]);

  if (!p)
    return (
      <div className="empty">
        <span className="spinner" />
      </div>
    );

  const start = async (text: string, attachments: Attachment[]) => {
    try {
      const { id: cid } = await api('/conversations', { body: { projectId: id, text, attachments } });
      navigate(`/c/${cid}`);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <a className="btn icon ghost" href="#/projects" aria-label="Back">
          <Icon name="arrowLeft" />
        </a>
        <span style={{ fontSize: 28 }}>{p.emoji}</span>
        <h1>{p.name}</h1>
      </div>
      <div className="tabs" style={{ width: 'fit-content' }}>
        <button className={`tab ${tab === 'overview' ? 'active' : ''}`} onClick={() => setTab('overview')}>
          Overview
        </button>
        <button className={`tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
          Settings
        </button>
      </div>

      {tab === 'overview' ? (
        <>
          <div style={{ marginBottom: 20 }}>
            <Composer onSend={start} placeholder={`Work on “${p.name}”…`} />
          </div>
          <div className="grid2" style={{ alignItems: 'start' }}>
            <div className="card">
              <div className="row" style={{ marginBottom: 8 }}>
                <span className="card-title grow">Tasks</span>
                <span className="small muted">{p.tasks.filter((t) => !t.done).length} open</span>
              </div>
              {p.tasks.map((t) => (
                <div key={t.id} className={`task ${t.done ? 'done' : ''}`}>
                  <input type="checkbox" checked={!!t.done} onChange={(e) => api(`/tasks/${t.id}`, { method: 'PATCH', body: { done: e.target.checked } })} />
                  <span className="tt grow">{t.title}</span>
                  {t.due && <span className="tag">{t.due}</span>}
                  <button className="btn icon ghost sm del" onClick={() => api(`/tasks/${t.id}`, { method: 'DELETE' })} aria-label="Delete task">
                    <Icon name="x" size={14} />
                  </button>
                </div>
              ))}
              <form
                className="row"
                style={{ marginTop: 10 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!task.trim()) return;
                  void api(`/projects/${id}/tasks`, { body: { title: task } });
                  setTask('');
                }}
              >
                <input className="input grow" value={task} onChange={(e) => setTask(e.target.value)} placeholder="Add a task" />
              </form>
            </div>
            <div className="card">
              <div className="row" style={{ marginBottom: 8 }}>
                <span className="card-title grow">Notes</span>
                {editingNotes ? (
                  <button
                    className="btn sm primary"
                    onClick={async () => {
                      await api(`/projects/${id}`, { method: 'PATCH', body: { notes } });
                      setEditingNotes(false);
                    }}
                  >
                    Save
                  </button>
                ) : (
                  <button className="btn sm" onClick={() => (setNotes(p.notes), setEditingNotes(true))}>
                    Edit
                  </button>
                )}
              </div>
              {editingNotes ? (
                <textarea className="textarea" style={{ minHeight: 260 }} value={notes} onChange={(e) => setNotes(e.target.value)} />
              ) : p.notes ? (
                <Markdown text={p.notes} />
              ) : (
                <p className="muted small">Errand writes findings, options and decisions here as you work.</p>
              )}
            </div>
          </div>
          <div className="section-title">Documents</div>
          <div
            className="list"
            style={{ display: 'block' }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={async (e) => {
              e.preventDefault();
              for (const f of Array.from(e.dataTransfer.files)) {
                try {
                  await api(`/projects/${id}/files`, { body: await fileToAttachment(f) });
                } catch (x) {
                  toast((x as Error).message);
                }
              }
            }}
          >
            {p.files.map((f) => (
              <div key={f.id} className="list-item">
                <span className="icon-chip">
                  <Icon name="clip" size={15} />
                </span>
                <span className="grow">{f.name}</span>
                <span className="small muted">{Math.round(f.chars / 1000)}k chars</span>
                <button className="btn icon sm" onClick={() => api(`/project-files/${f.id}`, { method: 'DELETE' })} aria-label="Remove">
                  <Icon name="x" size={14} />
                </button>
              </div>
            ))}
            <label className="row-link" style={{ cursor: 'default' }}>
              <span className="tile" style={{ background: '#007aff' }}>
                <Icon name="plus" size={15} stroke={2.2} />
              </span>
              <span className="grow">
                Add PDFs or text files <span className="muted small">(or drop them here)</span>
              </span>
              <input
                type="file"
                hidden
                multiple
                accept=".pdf,.txt,.md,.csv,.json,.html"
                onChange={async (e) => {
                  for (const f of Array.from(e.target.files ?? [])) {
                    try {
                      await api(`/projects/${id}/files`, { body: await fileToAttachment(f) });
                    } catch (x) {
                      toast((x as Error).message);
                    }
                  }
                  e.target.value = '';
                }}
              />
            </label>
          </div>
          <p className="hint" style={{ margin: '6px 14px 0' }}>
            Errand reads these whenever you work in this project.
          </p>
          <div className="section-title">Conversations</div>
          <div className="list">
            {p.conversations.map((c) => (
              <a key={c.id} href={`#/c/${c.id}`} className="list-item" style={{ textDecoration: 'none', color: 'inherit' }}>
                <Icon name="chat" size={16} />
                <span className="grow">{c.title}</span>
                <span className="small muted">{timeAgo(c.updated_at)}</span>
              </a>
            ))}
            {!p.conversations.length && <p className="muted small">No conversations yet.</p>}
          </div>
        </>
      ) : (
        <div className="card" style={{ maxWidth: 640 }}>
          <div className="row">
            <div className="field" style={{ width: 80 }}>
              <label>Emoji</label>
              <input className="input" value={meta.emoji} onChange={(e) => setMeta({ ...meta, emoji: e.target.value })} />
            </div>
            <div className="field grow">
              <label>Name</label>
              <input className="input" value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} />
            </div>
          </div>
          <label className="field">
            <span className="label">Description</span>
            <input className="input" value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} />
          </label>
          <label className="field">
            <span className="label">Instructions for Errand</span>
            <textarea
              className="textarea"
              value={meta.instructions}
              onChange={(e) => setMeta({ ...meta, instructions: e.target.value })}
              placeholder="e.g. Budget is $2,000/month. Only consider places within 20 minutes of downtown."
            />
          </label>
          <div className="row">
            <button className="btn primary" onClick={async () => (await api(`/projects/${id}`, { method: 'PATCH', body: meta }), toast('Saved'))}>
              Save
            </button>
            <span className="grow" />
            <button
              className="btn danger"
              onClick={async () => {
                if (!confirm('Delete this project? Its chats are kept.')) return;
                await api(`/projects/${id}`, { method: 'DELETE' });
                navigate('/projects');
              }}
            >
              Delete project
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
