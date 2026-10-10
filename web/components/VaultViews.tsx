import { useEffect, useState, type ReactNode } from 'react';
import { api, useResource } from '../api';
import { useApp } from '../context';
import { Icon } from './Icon';

export interface VaultItem {
  id: string;
  kind: 'login' | 'card' | 'identity' | 'note' | 'api_key';
  label: string;
  domain: string;
  hint: string;
  fields: string[];
}

interface VaultData {
  initialized: boolean;
  unlocked: boolean;
  items: VaultItem[];
  fields: Record<string, string[]>;
}

const SECRET_FIELDS = /password|number|cvc|text|totp|^key$/;
const KIND_LABEL: Record<string, string> = { login: 'Login', card: 'Card', identity: 'Identity', note: 'Note', api_key: 'API key' };

export function useVault() {
  return useResource<VaultData>('/vault', ['vault.updated']);
}

/** Shows children only when the vault exists and is unlocked; otherwise a setup/unlock form. */
export function VaultGate({ children }: { children: ReactNode }) {
  const { data: v, reload } = useVault();
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [error, setError] = useState('');
  if (!v)
    return (
      <div className="empty">
        <span className="spinner" />
      </div>
    );
  if (v.initialized && v.unlocked) return <>{children}</>;

  const submit = async () => {
    setError('');
    if (!v.initialized && pass !== pass2) return setError('Passphrases do not match');
    try {
      await api(v.initialized ? '/vault/unlock' : '/vault/setup', { body: { passphrase: pass } });
      setPass('');
      setPass2('');
      void reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="lock-hero" style={{ marginTop: 24 }}>
      <div className="lock-glyph">
        <Icon name="lock" size={28} />
      </div>
      <h1>{v.initialized ? 'Vault locked' : 'Set up your vault'}</h1>
      <p className="muted">
        {v.initialized
          ? 'Enter your passphrase. The key stays in memory only and locks itself when idle.'
          : 'Logins and cards are encrypted on this device with a passphrase only you know (AES-256-GCM). AI models only ever see placeholders.'}
      </p>
      <form className="card" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <label className="field">
          <span className="label">Passphrase</span>
          <input
            className="input"
            type="password"
            autoFocus
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            autoComplete={v.initialized ? 'current-password' : 'new-password'}
          />
        </label>
        {!v.initialized && (
          <label className="field">
            <span className="label">Confirm passphrase</span>
            <input className="input" type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" />
            <span className="hint">At least 8 characters. There is no recovery, so keep it somewhere safe.</span>
          </label>
        )}
        {error && (
          <div className="error-box" style={{ marginBottom: 14 }}>
            {error}
          </div>
        )}
        <button className="btn primary" style={{ width: '100%' }} disabled={pass.length < 8}>
          {v.initialized ? 'Unlock' : 'Create vault'}
        </button>
      </form>
    </div>
  );
}

/** Add/edit form for a vault item. Editing never reveals secrets: blank fields keep their value. */
export function VaultItemSheet({
  initial,
  onClose,
  onSaved,
}: {
  initial: { id?: string; kind: string; label: string; domain: string };
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { toast } = useApp();
  const { data: v } = useVault();
  const [form, setForm] = useState({ ...initial, fields: {} as Record<string, string> });
  const [error, setError] = useState('');
  if (!v) return null;

  const save = async () => {
    try {
      if (form.id) await api(`/vault/items/${form.id}`, { method: 'PATCH', body: { label: form.label, domain: form.domain, fields: form.fields } });
      else await api('/vault/items', { body: form });
      toast('Saved');
      onSaved?.();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>{form.id ? `Edit ${form.label}` : `New ${KIND_LABEL[form.kind].toLowerCase()}`}</h2>
        {form.id && <p className="hint">Leave a field blank to keep its current value.</p>}
        <div className="field" style={{ marginTop: 16 }}>
          <label>Label</label>
          <input
            className="input"
            autoFocus
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
            placeholder={form.kind === 'card' ? 'Personal Visa' : form.kind === 'login' ? 'Amazon' : 'Home'}
          />
        </div>
        {form.kind === 'login' && (
          <label className="field">
            <span className="label">Website</span>
            <input className="input" value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="amazon.com" />
            <span className="hint">The browser agent only types this login on this site and its subdomains.</span>
          </label>
        )}
        {form.kind === 'api_key' && (
          <p className="hint" style={{ marginTop: -6 }}>
            The label is the service name you’ll use in chat (e.g. “Strava”). The key is only ever sent to the base URL.
          </p>
        )}
        <div className="grid2">
          {v.fields[form.kind].map((f) => (
            <div key={f} className="field" style={f === 'text' ? { gridColumn: '1 / -1' } : undefined}>
              <label style={{ textTransform: 'capitalize' }}>{f.replace(/_/g, ' ')}</label>
              {f === 'text' ? (
                <textarea
                  className="textarea"
                  value={form.fields[f] ?? ''}
                  onChange={(e) => setForm({ ...form, fields: { ...form.fields, [f]: e.target.value } })}
                />
              ) : (
                <input
                  className="input"
                  type={SECRET_FIELDS.test(f) ? 'password' : 'text'}
                  autoComplete="off"
                  placeholder={form.id ? 'unchanged' : ''}
                  value={form.fields[f] ?? ''}
                  onChange={(e) => setForm({ ...form, fields: { ...form.fields, [f]: e.target.value } })}
                />
              )}
            </div>
          ))}
        </div>
        {error && (
          <div className="error-box" style={{ marginBottom: 12 }}>
            {error}
          </div>
        )}
        <div className="foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!form.label.trim() || (form.kind === 'api_key' && !form.id && !(form.fields.key && form.fields.base_url))}
            onClick={save}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/** A list of vault items with passphrase-confirmed reveal, edit and delete. */
export function VaultList({ kinds, empty }: { kinds: VaultItem['kind'][]; empty: ReactNode }) {
  const { toast } = useApp();
  const { data: v } = useVault();
  const [editing, setEditing] = useState<VaultItem | null>(null);
  const [revealing, setRevealing] = useState<string | null>(null);
  const [revealPass, setRevealPass] = useState('');
  const [revealed, setRevealed] = useState<Record<string, Record<string, string>>>({});
  useEffect(() => setRevealed({}), [v?.unlocked]);
  const items = v?.items.filter((i) => kinds.includes(i.kind)) ?? [];
  if (!items.length)
    return (
      <div className="list">
        <div className="empty">{empty}</div>
      </div>
    );

  return (
    <>
      <div className="list">
        {items.map((it) => (
          <div key={it.id} className="list-item" style={{ alignItems: 'flex-start' }}>
            <span className="icon-chip">
              <Icon name={it.kind === 'login' || it.kind === 'api_key' ? 'key' : it.kind === 'card' ? 'card' : 'person'} size={16} />
            </span>
            <div className="grow">
              <div style={{ fontWeight: 500 }}>{it.label}</div>
              <div className="small muted">{[it.domain, it.hint].filter(Boolean).join(' · ') || KIND_LABEL[it.kind]}</div>
              {revealing === it.id && (
                <form
                  className="row"
                  style={{ marginTop: 10 }}
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      setRevealed({ ...revealed, [it.id]: await api(`/vault/items/${it.id}/reveal`, { body: { passphrase: revealPass } }) });
                      setRevealing(null);
                      setRevealPass('');
                    } catch (x) {
                      toast((x as Error).message);
                    }
                  }}
                >
                  <input
                    className="input grow"
                    type="password"
                    autoFocus
                    placeholder="Confirm passphrase to reveal"
                    value={revealPass}
                    onChange={(e) => setRevealPass(e.target.value)}
                  />
                  <button className="btn sm primary">Reveal</button>
                </form>
              )}
              {revealed[it.id] && (
                <div className="secret" style={{ marginTop: 10, display: 'grid', gap: 3 }}>
                  {Object.entries(revealed[it.id])
                    .filter(([, val]) => val)
                    .map(([k, val]) => (
                      <div key={k}>
                        <span className="muted">{k.replace(/_/g, ' ')}</span> {val}
                      </div>
                    ))}
                </div>
              )}
            </div>
            <button
              className="btn icon sm"
              title={revealed[it.id] ? 'Hide' : 'Reveal'}
              onClick={() => (revealed[it.id] ? setRevealed(({ [it.id]: _, ...rest }) => rest) : setRevealing(revealing === it.id ? null : it.id))}
            >
              <Icon name="eye" size={15} />
            </button>
            <button className="btn icon sm" title="Edit" onClick={() => setEditing(it)}>
              <Icon name="edit" size={15} />
            </button>
            <button
              className="btn icon sm"
              title="Delete"
              onClick={() => confirm(`Delete “${it.label}”?`) && api(`/vault/items/${it.id}`, { method: 'DELETE' })}
            >
              <Icon name="trash" size={15} />
            </button>
          </div>
        ))}
      </div>
      {editing && <VaultItemSheet initial={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
