import { useEffect, useState, type ReactNode } from 'react';
import { api, navigate, useResource } from '../api';
import { useApp, type AppSettings } from '../context';
import { VaultGate, VaultItemSheet, VaultList, useVault } from './VaultViews';
import { Icon } from './Icon';

// ── Shared bits ───────────────────────────────────────────────────────────────

function useDraft() {
  const { settings, reloadSettings, toast } = useApp();
  const [draft, setDraft] = useState<AppSettings | null>(settings);
  useEffect(() => setDraft(settings), [settings]);
  const save = async (part: Partial<AppSettings>, message = 'Saved') => {
    await api('/settings', { method: 'PUT', body: part });
    await reloadSettings();
    toast(message);
  };
  return { draft, setDraft, save, toast, reloadSettings };
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button type="button" className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} role="switch" aria-checked={on} aria-label={label} />;
}

function Sub({ title, children, lede }: { title: string; lede?: string; children: ReactNode }) {
  return (
    <div className="page page-narrow">
      <a className="back" href="#/settings">
        <Icon name="chevronLeft" size={18} /> Settings
      </a>
      <div className="page-head">
        <h1>{title}</h1>
      </div>
      {lede && <p className="lede">{lede}</p>}
      {children}
    </div>
  );
}

function Group({ title, foot, children }: { title?: string; foot?: ReactNode; children: ReactNode }) {
  return (
    <div className="group">
      {title && <div className="group-title">{title}</div>}
      <div className="list">{children}</div>
      {foot && <div className="group-foot">{foot}</div>}
    </div>
  );
}

function RowLink({ href, icon, label, value }: { href: string; icon: string; label: string; value?: string }) {
  const external = href.startsWith('http');
  return (
    <a className="row-link" href={href} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}>
      <span className="tile">
        <Icon name={icon} size={16} stroke={2} />
      </span>
      <span className="grow">{label}</span>
      {value && <span className="value">{value}</span>}
      <Icon name="chevronRight" size={16} />
    </a>
  );
}

// ── Router ────────────────────────────────────────────────────────────────────

export function SettingsPage({ page, query }: { page?: string; query: URLSearchParams }) {
  const { toast } = useApp();
  useEffect(() => {
    const connected = query.get('connected');
    const error = query.get('error');
    if (connected) toast(connected === 'chatgpt' ? 'ChatGPT connected' : connected === 'openrouter' ? 'OpenRouter connected' : `${connected} connected`);
    if (error) toast(error);
  }, [query.toString()]);

  switch (page) {
    case 'profile':
      return <ProfileSettings />;
    case 'accounts':
      return <AccountsSettings tab={query.get('tab') ?? 'connections'} site={query.get('site') ?? ''} />;
    case 'wallet':
      return <WalletSettings />;
    case 'models':
      return <ModelsPage />;
    case 'integrations':
      return <IntegrationsSettings />;
    case 'browser':
      return <BrowserSettings />;
    case 'notifications':
      return <NotificationSettings />;
    case 'security':
      return <SecuritySettings />;
    case 'about':
      return <AboutSettings />;
    case 'phone':
      return <PhoneSettings />;
    default:
      return <SettingsHome />;
  }
}

function SettingsHome() {
  const { settings } = useApp();
  const { data: accounts } = useResource<{ address: string }[]>('/accounts/email', ['accounts.updated']);
  const { data: providers } = useResource<{ providers: Provider[] }>('/providers', ['settings.updated']);
  const { data: version } = useResource<VersionInfo>('/version', []);
  const chatModel = settings?.models.chat.split(':').slice(1).join(':');
  const name = settings?.userName || 'You';
  return (
    <div className="page page-narrow">
      <div className="settings-header">
        <span className="avatar">{name.charAt(0).toUpperCase()}</span>
        <div>
          <div className="name">{name}</div>
          <div className="small muted">{settings?.location?.name ?? 'Location not set'}</div>
        </div>
      </div>
      <Group>
        <RowLink href="#/settings/profile" icon="person" label="Profile" />
        <RowLink href="#/settings/accounts" icon="key" label="Accounts" value={accounts?.length ? `${accounts.length} connected` : undefined} />
        <RowLink href="#/settings/wallet" icon="card" label="Wallet" />
        <RowLink href="#/routines" icon="clock" label="Scheduled tasks" />
      </Group>
      <Group>
        <RowLink
          href="#/settings/models"
          icon="cpu"

          label="AI models"
          value={chatModel || (providers?.providers.length ? undefined : 'Not connected')}
        />
        <RowLink href="#/settings/integrations" icon="plug" label="Integrations" />
        <RowLink href="#/settings/browser" icon="globe" label="Browser agent" />
        <RowLink href="#/settings/phone" icon="phone" label="Use on your phone" />
        <RowLink href="#/settings/notifications" icon="bell" label="Notifications" />
      </Group>
      <Group>
        <RowLink href="#/settings/security" icon="shield" label="Privacy & security" />
        <RowLink href="#/settings/about" icon="info" label="About Errand" value={version?.update ? 'Update available' : undefined} />
        <RowLink href={FEEDBACK} icon="chat" label="Send feedback" />
      </Group>
    </div>
  );
}

// ── Profile ───────────────────────────────────────────────────────────────────

function ProfileSettings() {
  const { draft, setDraft, save } = useDraft();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ name: string; lat: number; lon: number; timezone: string }[]>([]);
  if (!draft) return null;
  const find = async () => setResults(await api(`/geocode?q=${encodeURIComponent(q)}`));
  return (
    <Sub title="Profile" lede="Tip: you can also just tell Errand in chat, like “I moved to Denver” or “call me Sam”.">
      <div className="card">
        <label className="field">
          <span className="label">Name</span>
          <input className="input" value={draft.userName} onChange={(e) => setDraft({ ...draft, userName: e.target.value })} />
        </label>
        <div className="field">
          <label>Location</label>
          <div className="row">
            <input
              className="input grow"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={draft.location?.name ?? 'Search a city'}
              onKeyDown={(e) => e.key === 'Enter' && find()}
            />
            <button className="btn" onClick={find}>
              Search
            </button>
          </div>
          {results.map((r) => (
            <button
              key={`${r.lat},${r.lon}`}
              className="btn ghost sm"
              style={{ justifyContent: 'flex-start' }}
              onClick={() => (
                setDraft({ ...draft, location: { name: r.name, lat: r.lat, lon: r.lon }, timezone: r.timezone || draft.timezone }),
                setResults([]),
                setQ('')
              )}
            >
              {r.name}
            </button>
          ))}
          <span className="hint">{draft.location ? `Current: ${draft.location.name}` : 'Used for weather and local tasks.'}</span>
        </div>
        <label className="field">
          <span className="label">Time zone</span>
          <input className="input" value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} />
        </label>
        <label className="field">
          <span className="label">How Errand should work for you</span>
          <textarea
            className="textarea"
            value={draft.customInstructions}
            onChange={(e) => setDraft({ ...draft, customInstructions: e.target.value })}
            placeholder="e.g. Be brief. Aisle seats. Never spend more than $300 without checking with me."
          />
        </label>
        <button
          className="btn primary"
          onClick={() => save({ userName: draft.userName, location: draft.location, timezone: draft.timezone, customInstructions: draft.customInstructions })}
        >
          Save
        </button>
      </div>
    </Sub>
  );
}

// ── Accounts: Connections / Logins / API Keys ─────────────────────────────────

interface EmailAccount {
  id: string;
  kind: 'google' | 'microsoft' | 'imap';
  address: string;
}

const POPULAR_SITES = [
  ['Amazon', 'amazon.com'],
  ['Target', 'target.com'],
  ['Walmart', 'walmart.com'],
  ['Costco', 'costco.com'],
  ['eBay', 'ebay.com'],
  ['DoorDash', 'doordash.com'],
  ['Uber Eats', 'ubereats.com'],
  ['Instacart', 'instacart.com'],
  ['Uber', 'uber.com'],
  ['Lyft', 'lyft.com'],
  ['OpenTable', 'opentable.com'],
  ['Resy', 'resy.com'],
  ['Airbnb', 'airbnb.com'],
  ['Booking.com', 'booking.com'],
  ['Expedia', 'expedia.com'],
  ['United Airlines', 'united.com'],
  ['Delta Air Lines', 'delta.com'],
  ['American Airlines', 'aa.com'],
  ['LinkedIn', 'linkedin.com'],
  ['Netflix', 'netflix.com'],
  ['Spotify', 'spotify.com'],
  ['PayPal', 'paypal.com'],
  ['Zocdoc', 'zocdoc.com'],
  ['Ramp', 'ramp.com'],
  ['Notion', 'notion.so'],
];

function AccountsSettings({ tab, site }: { tab: string; site: string }) {
  const setTab = (t: string) => navigate(`/settings/accounts?tab=${t}`);
  return (
    <Sub title="Accounts" lede="Everything Errand can use on your behalf. You can also connect things by asking in chat.">
      <div className="tabs">
        {[
          ['connections', 'Connections'],
          ['logins', 'Logins'],
          ['keys', 'API Keys'],
        ].map(([k, label]) => (
          <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'logins' ? <LoginsTab site={site} /> : tab === 'keys' ? <KeysTab site={site} /> : <ConnectionsTab />}
    </Sub>
  );
}

export const MAIL_PRESETS: Record<
  string,
  { imapHost: string; imapPort: number; imapSecure: boolean; smtpHost: string; smtpPort: number; smtpSecure: boolean }
> = {
  'Outlook / Microsoft 365': {
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    smtpSecure: false,
  },
  iCloud: { imapHost: 'imap.mail.me.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSecure: false },
  Fastmail: { imapHost: 'imap.fastmail.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.fastmail.com', smtpPort: 465, smtpSecure: true },
  Zoho: { imapHost: 'imap.zoho.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.zoho.com', smtpPort: 465, smtpSecure: true },
  Yahoo: { imapHost: 'imap.mail.yahoo.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465, smtpSecure: true },
  'Gmail (app password)': { imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true },
};

function ConnectionsTab() {
  const { draft, setDraft, save, toast } = useDraft();
  const { phone } = useApp();
  const { data: accounts, reload } = useResource<EmailAccount[]>('/accounts/email', ['accounts.updated']);
  const [imap, setImap] = useState<null | ({ address: string; password: string; displayName: string } & (typeof MAIL_PRESETS)[string])>(null);
  const [busy, setBusy] = useState(false);
  const [cal, setCal] = useState({ name: '', url: '' });
  const [root, setRoot] = useState('');
  const [googleSetup, setGoogleSetup] = useState(false);
  const [msSetup, setMsSetup] = useState(false);
  if (!draft) return null;
  const g = draft.google as AppSettings['google'] & { hasClientSecret?: boolean; redirectUri?: string };
  const googleReady = !!g.clientId && !!g.hasClientSecret;

  const addImap = async () => {
    if (!imap) return;
    setBusy(true);
    try {
      await api('/accounts/email', { body: imap });
      setImap(null);
      toast(`${imap.address} connected. Errand is catching up on it.`);
      void reload();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Group title="Google" foot={googleReady ? 'Gmail, Calendar and Drive. Connect as many Google accounts as you like.' : undefined}>
        {accounts
          ?.filter((a) => a.kind === 'google')
          .map((a) => (
            <div key={a.id} className="list-item">
              <span className="icon-chip">
                <Icon name="mail" size={16} />
              </span>
              <div className="grow">
                <div>{a.address}</div>
                <div className="small muted">Gmail · Calendar · Drive</div>
              </div>
              <button className="btn sm danger" onClick={() => confirm(`Disconnect ${a.address}?`) && api(`/accounts/email/${a.id}`, { method: 'DELETE' })}>
                Disconnect
              </button>
            </div>
          ))}
        {googleReady && !googleSetup && phone ? (
          <div className="list-item muted">To connect a Google account, open Errand on your computer.</div>
        ) : googleReady && !googleSetup ? (
          <div className="list-item">
            <a className="btn primary" href="/api/oauth/google/start">
              <Icon name="plus" size={14} /> Connect a Google account
            </a>
            <span className="grow" />
            <button className="btn sm ghost" onClick={() => setGoogleSetup(true)}>
              OAuth settings
            </button>
          </div>
        ) : (
          <div className="list-item" style={{ display: 'block' }}>
            <p className="small" style={{ marginTop: 0 }}>
              One-time setup, about 3 minutes. Errand uses <b>your own</b> Google OAuth client, so your data goes from Google straight to your computer and
              nobody else is in between.
            </p>
            <ol className="small muted" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
              <li>
                Open{' '}
                <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
                  Google Cloud → Credentials
                </a>
                , create a project if needed, and enable the Gmail, Calendar and Drive APIs.
              </li>
              <li>
                Create an <b>OAuth client ID</b> of type <b>Web application</b>.
              </li>
              <li>
                Add this authorized redirect URI: <code className="secret">{g.redirectUri}</code>
              </li>
              <li>Paste the client ID and secret below. While the app is in “Testing”, add your Google accounts as test users.</li>
            </ol>
            <div className="grid2">
              <label className="field">
                <span className="label">Client ID</span>
                <input className="input" value={g.clientId} onChange={(e) => setDraft({ ...draft, google: { ...g, clientId: e.target.value } })} />
              </label>
              <label className="field">
                <span className="label">Client secret</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="off"
                  value={g.clientSecret}
                  placeholder={g.hasClientSecret ? '•••••••• (saved)' : ''}
                  onChange={(e) => setDraft({ ...draft, google: { ...g, clientSecret: e.target.value } })}
                />
              </label>
            </div>
            <button
              className="btn primary"
              onClick={async () => (await save({ google: { clientId: g.clientId, clientSecret: g.clientSecret } }), setGoogleSetup(false))}
            >
              Save
            </button>
          </div>
        )}
      </Group>

      <Group title="Outlook, Hotmail and Microsoft 365" foot="Mail through Microsoft’s own sign-in; no app password needed.">
        {accounts
          ?.filter((a) => a.kind === 'microsoft')
          .map((a) => (
            <div key={a.id} className="list-item">
              <span className="icon-chip">
                <Icon name="mail" size={16} />
              </span>
              <span className="grow">{a.address}</span>
              <button className="btn sm danger" onClick={() => confirm(`Disconnect ${a.address}?`) && api(`/accounts/email/${a.id}`, { method: 'DELETE' })}>
                Disconnect
              </button>
            </div>
          ))}
        {draft.microsoft?.ready && !msSetup && phone ? (
          <div className="list-item muted">To connect a Microsoft account, open Errand on your computer.</div>
        ) : draft.microsoft?.ready && !msSetup ? (
          <div className="list-item">
            <a className="btn primary" href="/api/oauth/microsoft/start">
              <Icon name="plus" size={14} /> Continue with Microsoft
            </a>
            <span className="grow" />
            <button className="btn sm ghost" onClick={() => setMsSetup(true)}>
              App settings
            </button>
          </div>
        ) : (
          <div className="list-item" style={{ display: 'block' }}>
            <p className="small" style={{ marginTop: 0 }}>
              One-time setup, about 3 minutes, with a free Microsoft app registration of your own.
            </p>
            <ol className="small muted" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
              <li>
                Open{' '}
                <a href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noreferrer">
                  Microsoft Entra → App registrations
                </a>{' '}
                and choose <b>New registration</b>.
              </li>
              <li>
                Supported accounts: <b>any organizational directory and personal Microsoft accounts</b>. Redirect URI: <b>Public client/native</b>,{' '}
                <code className="secret">http://localhost</code>
              </li>
              <li>
                Under <b>API permissions</b>, add Microsoft Graph delegated permissions <b>IMAP.AccessAsUser.All</b>, <b>SMTP.Send</b> and <b>offline_access</b>
                .
              </li>
              <li>
                Copy the <b>Application (client) ID</b> and paste it below.
              </li>
            </ol>
            <label className="field">
              <span className="label">Application (client) ID</span>
              <input
                className="input"
                value={draft.microsoft?.clientId ?? ''}
                onChange={(e) => setDraft({ ...draft, microsoft: { ...draft.microsoft!, clientId: e.target.value } })}
              />
            </label>
            <button className="btn primary" onClick={async () => (await save({ microsoft: draft.microsoft }), setMsSetup(false))}>
              Save
            </button>
          </div>
        )}
      </Group>

      <Group title="Other email" foot="Any provider over IMAP, using an app password from your account’s security settings.">
        {accounts
          ?.filter((a) => a.kind === 'imap')
          .map((a) => (
            <div key={a.id} className="list-item">
              <span className="icon-chip">
                <Icon name="mail" size={16} />
              </span>
              <span className="grow">{a.address}</span>
              <button className="btn sm danger" onClick={() => confirm(`Disconnect ${a.address}?`) && api(`/accounts/email/${a.id}`, { method: 'DELETE' })}>
                Disconnect
              </button>
            </div>
          ))}
        {imap ? (
          <div className="list-item" style={{ display: 'block' }}>
            <div className="row" style={{ marginBottom: 12 }}>
              {Object.keys(MAIL_PRESETS).map((k) => (
                <button key={k} className="btn sm" onClick={() => setImap({ ...imap, ...MAIL_PRESETS[k] })}>
                  {k}
                </button>
              ))}
            </div>
            <div className="grid2">
              <label className="field">
                <span className="label">Email address</span>
                <input className="input" value={imap.address} onChange={(e) => setImap({ ...imap, address: e.target.value })} />
              </label>
              <label className="field">
                <span className="label">App password</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="off"
                  value={imap.password}
                  onChange={(e) => setImap({ ...imap, password: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="label">IMAP server</span>
                <input className="input" value={imap.imapHost} onChange={(e) => setImap({ ...imap, imapHost: e.target.value })} />
              </label>
              <label className="field">
                <span className="label">SMTP server</span>
                <input className="input" value={imap.smtpHost} onChange={(e) => setImap({ ...imap, smtpHost: e.target.value })} />
              </label>
              <label className="field">
                <span className="label">Your name (for sent mail)</span>
                <input className="input" value={imap.displayName} onChange={(e) => setImap({ ...imap, displayName: e.target.value })} />
              </label>
            </div>
            <div className="row">
              <button className="btn primary" disabled={busy || !imap.address || !imap.password || !imap.imapHost} onClick={addImap}>
                {busy ? 'Connecting…' : 'Connect'}
              </button>
              <button className="btn" onClick={() => setImap(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            className="row-link"
            onClick={() => setImap({ address: '', password: '', displayName: draft.userName, ...MAIL_PRESETS['Outlook / Microsoft 365'] })}
          >
            <span className="tile">
              <Icon name="plus" size={15} stroke={2.2} />
            </span>
            <span className="grow">Add a mailbox</span>
          </button>
        )}
      </Group>

      <Group
        title="Calendars (iCal links)"
        foot="Google calendars come with your Google account. For others paste the iCal (.ics) link: Outlook → Publish calendar, iCloud → Public calendar."
      >
        {draft.calendars.map((c, i) => (
          <div key={i} className="list-item">
            <span className="icon-chip">
              <Icon name="calendar" size={16} />
            </span>
            <span className="grow">{c.name}</span>
            <button className="btn icon sm" onClick={() => save({ calendars: draft.calendars.filter((_, j) => j !== i) })}>
              <Icon name="trash" size={15} />
            </button>
          </div>
        ))}
        <div className="list-item">
          <input className="input" style={{ width: 130 }} value={cal.name} onChange={(e) => setCal({ ...cal, name: e.target.value })} placeholder="Name" />
          <input className="input grow" value={cal.url} onChange={(e) => setCal({ ...cal, url: e.target.value })} placeholder="https://….ics" />
          <button
            className="btn"
            disabled={!cal.url}
            onClick={async () => (
              await save({ calendars: [...draft.calendars, { name: cal.name || 'Calendar', url: cal.url }] }),
              setCal({ name: '', url: '' })
            )}
          >
            Add
          </button>
        </div>
      </Group>

      <Group title="Files on this computer" foot="Folders Errand may read, and write with your approval. Nothing outside them is reachable.">
        {draft.files.roots.map((r, i) => (
          <div key={i} className="list-item">
            <span className="icon-chip">
              <Icon name="folder" size={16} />
            </span>
            <span className="grow secret">{r}</span>
            <button className="btn icon sm" onClick={() => save({ files: { roots: draft.files.roots.filter((_, j) => j !== i) } })}>
              <Icon name="trash" size={15} />
            </button>
          </div>
        ))}
        <div className="list-item">
          <input className="input grow" value={root} onChange={(e) => setRoot(e.target.value)} placeholder="C:\Users\you\Documents  or  /home/you/Documents" />
          <button className="btn" disabled={!root} onClick={async () => (await save({ files: { roots: [...draft.files.roots, root] } }), setRoot(''))}>
            Add
          </button>
        </div>
      </Group>

      <Group title="Apps">
        <RowLink href="#/settings/integrations" icon="plug" label="Slack, GitHub, Notion, Spotify, Strava and more" />
      </Group>
    </>
  );
}

function LoginsTab({ site }: { site: string }) {
  const { data: vault } = useVault();
  const [sheet, setSheet] = useState<{ label: string; domain: string } | null>(site ? { label: site, domain: site } : null);
  const saved = new Set(vault?.items.filter((i) => i.kind === 'login').map((i) => i.domain));

  const signIn = async (label: string) => {
    const { id } = await api<{ id: string }>('/conversations/main');
    await api(`/conversations/${id}/messages`, { body: { text: `Sign me into ${label} with my saved login and keep me signed in.` } });
    navigate('/chat');
  };

  return (
    <VaultGate>
      <Group title="Saved logins" foot="The browser agent signs in with these, only on their own site. It picks up verification codes from your email.">
        <VaultList
          kinds={['login']}
          empty={
            <>
              <div className="big">No logins yet</div>Connect a site below, or let Errand create accounts for you as it works.
            </>
          }
        />
      </Group>
      <Group title="Popular sites">
        {POPULAR_SITES.map(([label, domain]) => (
          <div key={domain} className="list-item">
            <span className="grow">{label}</span>
            {saved.has(domain) ? (
              <button className="btn sm" onClick={() => signIn(label)}>
                Sign in now
              </button>
            ) : (
              <button className="btn sm" onClick={() => setSheet({ label, domain })}>
                Connect
              </button>
            )}
          </div>
        ))}
        <button className="row-link" onClick={() => setSheet({ label: '', domain: '' })}>
          <span className="tile">
            <Icon name="plus" size={15} stroke={2.2} />
          </span>
          <span className="grow">Another site</span>
        </button>
      </Group>
      {sheet && <VaultItemSheet initial={{ kind: 'login', ...sheet }} onClose={() => setSheet(null)} onSaved={() => sheet.label && void signIn(sheet.label)} />}
    </VaultGate>
  );
}

function KeysTab({ site }: { site: string }) {
  const [sheet, setSheet] = useState(!!site);
  return (
    <VaultGate>
      <Group
        title="Service API keys"
        foot="Give Errand a key for any service with an API (Strava, Notion, Airtable, your own tools) and it can use it from chat and panels. Each key is only ever sent to its base URL, and anything other than reading asks you first."
      >
        <VaultList
          kinds={['api_key']}
          empty={
            <>
              <div className="big">No API keys yet</div>Add one, or ask Errand in chat to connect a service.
            </>
          }
        />
        <button className="row-link" onClick={() => setSheet(true)}>
          <span className="tile">
            <Icon name="plus" size={15} stroke={2.2} />
          </span>
          <span className="grow">Add an API key</span>
        </button>
      </Group>
      <Group title="AI model keys">
        <RowLink href="#/settings/models" icon="cpu" label="Manage AI providers" />
      </Group>
      {sheet && <VaultItemSheet initial={{ kind: 'api_key', label: site, domain: '' }} onClose={() => setSheet(false)} />}
    </VaultGate>
  );
}

// ── Wallet ────────────────────────────────────────────────────────────────────

function WalletSettings() {
  const [sheet, setSheet] = useState<'card' | 'identity' | null>(null);
  return (
    <Sub title="Wallet" lede="Cards and addresses for checkouts and forms. Encrypted on this device; Errand asks before using them on any new site.">
      <VaultGate>
        <Group title="Cards">
          <VaultList
            kinds={['card']}
            empty={
              <>
                <div className="big">No saved cards</div>
              </>
            }
          />
          <button className="row-link" onClick={() => setSheet('card')}>
            <span className="tile">
              <Icon name="card" size={15} stroke={2} />
            </span>
            <span className="grow">Add a new card</span>
          </button>
        </Group>
        <Group title="Addresses & identity">
          <VaultList
            kinds={['identity']}
            empty={
              <>
                <div className="big">No saved details</div>
              </>
            }
          />
          <button className="row-link" onClick={() => setSheet('identity')}>
            <span className="tile">
              <Icon name="person" size={15} stroke={2} />
            </span>
            <span className="grow">Add address & contact details</span>
          </button>
        </Group>
        {sheet && <VaultItemSheet initial={{ kind: sheet, label: '', domain: '' }} onClose={() => setSheet(null)} />}
      </VaultGate>
    </Sub>
  );
}

// ── AI models ─────────────────────────────────────────────────────────────────

interface Provider {
  id: string;
  kind: string;
  name: string;
  baseUrl: string;
  hasKey: boolean;
  account?: string;
  models: string[];
}
interface Preset {
  preset: string;
  kind: string;
  name: string;
  baseUrl: string;
  needsKey: boolean;
}

function ModelsPage() {
  return (
    <Sub
      title="AI models"
      lede="Use the AI you already pay for. Sign in with your ChatGPT plan or OpenRouter, paste any API key, or run models locally. No Errand subscription, ever."
    >
      <ModelSettings />
      <SearchSettings />
    </Sub>
  );
}

export function ModelSettings({ compact, onAdded, from }: { compact?: boolean; onAdded?: (ref: string) => void; from?: string }) {
  const startQuery = from ? `?from=${encodeURIComponent(from)}` : '';
  const { draft, save, toast, reloadSettings } = useDraft();
  const { phone } = useApp();
  const { data, reload } = useResource<{ providers: Provider[]; presets: Preset[] }>('/providers', ['settings.updated']);
  const [adding, setAdding] = useState<{
    preset: Preset;
    name: string;
    baseUrl: string;
    apiKey: string;
    models: string[];
    available: string[];
    manual: string;
    auto: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [testing, setTesting] = useState<Record<string, string>>({});
  const [roles, setRoles] = useState(draft?.models ?? { chat: '', handoff: '', utility: '' });
  useEffect(() => {
    if (draft) setRoles(draft.models);
  }, [draft]);
  if (!data) return null;
  const allModels = data.providers.flatMap((p) => p.models.map((m) => ({ ref: `${p.id}:${m}`, label: `${p.name} · ${m}` })));
  const hasChatGPT = data.providers.some((p) => p.kind === 'chatgpt');

  const fetchModels = async () => {
    if (!adding) return;
    setBusy(true);
    setErr('');
    try {
      const { models } = await api('/providers/models', { body: { kind: adding.preset.kind, baseUrl: adding.baseUrl, apiKey: adding.apiKey } });
      setAdding({ ...adding, available: models });
      if (!models.length) setErr('No models returned. Type model ids below.');
    } catch (e) {
      setErr(`Could not list models: ${(e as Error).message}. You can type model ids below.`);
    } finally {
      setBusy(false);
    }
  };

  const addProvider = async () => {
    if (!adding) return;
    if (adding.auto) {
      setBusy(true);
      setErr('');
      try {
        const res = await api<{ id: string; models: { best: string; fast: string } }>('/providers', {
          body: { kind: adding.preset.kind, name: adding.name, baseUrl: adding.baseUrl, apiKey: adding.apiKey, auto: true },
        });
        setAdding(null);
        await Promise.all([reload(), reloadSettings()]);
        toast(`${adding.name} added. Chat uses ${res.models.best}.`);
        onAdded?.(`${res.id}:${res.models.best}`);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    const manual = adding.manual
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const models = [...new Set([...adding.models, ...manual])];
    if (!models.length) return setErr('Pick or type at least one model.');
    const { id } = await api<{ id: string }>('/providers', {
      body: { kind: adding.preset.kind, name: adding.name, baseUrl: adding.baseUrl, apiKey: adding.apiKey, models },
    });
    setAdding(null);
    await Promise.all([reload(), reloadSettings()]);
    toast(`${adding.name} added`);
    onAdded?.(`${id}:${models[0]}`);
  };

  return (
    <>
      <Group title="Sign in" foot="Uses your ChatGPT Go, Plus or Pro plan, or your OpenRouter account. No API key needed.">
        {phone ? (
          <div className="list-item">Sign in on your computer: open Errand there and choose Continue with ChatGPT or OpenRouter.</div>
        ) : (
          <div className="list-item" style={{ flexWrap: 'wrap' }}>
            <a className="chatgpt-btn" href={`/api/oauth/chatgpt/start${startQuery}`}>
              {hasChatGPT ? 'Reconnect ChatGPT' : 'Continue with ChatGPT'}
            </a>
            <a className="chatgpt-btn secondary" href={`/api/oauth/openrouter/start${startQuery}`}>
              Continue with OpenRouter
            </a>
          </div>
        )}
      </Group>

      <Group
        title={data.providers.length ? 'Connected' : 'Or use an API key or a local model'}
        foot="Anthropic and Google don’t let their consumer plans be used in other apps, so for their models add an API key here."
      >
        {data.providers.map((p) => (
          <div key={p.id} className="list-item">
            <span className="icon-chip">
              <Icon name="cpu" size={16} />
            </span>
            <div className="grow">
              <div>
                {p.name}
                {p.account ? ` · ${p.account}` : ''}
              </div>
              <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 480 }}>
                {p.models.length} model{p.models.length === 1 ? '' : 's'}
                {p.models.length ? `: ${p.models.slice(0, 4).join(', ')}${p.models.length > 4 ? '…' : ''}` : ''}
              </div>
            </div>
            <button
              className="btn icon sm"
              title="Remove"
              onClick={async () => confirm(`Remove ${p.name}?`) && (await api(`/providers/${p.id}`, { method: 'DELETE' }), reload(), reloadSettings())}
            >
              <Icon name="trash" size={15} />
            </button>
          </div>
        ))}
        {adding ? (
          <div className="list-item" style={{ display: 'block' }}>
            <div className="grid2">
              <label className="field">
                <span className="label">Name</span>
                <input className="input" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
              </label>
              {(adding.preset.kind === 'openai-compatible' || adding.baseUrl) && (
                <label className="field">
                  <span className="label">Base URL</span>
                  <input
                    className="input"
                    value={adding.baseUrl}
                    onChange={(e) => setAdding({ ...adding, baseUrl: e.target.value })}
                    placeholder="https://…/v1"
                  />
                </label>
              )}
            </div>
            <label className="field">
              <span className="label">API key {adding.preset.needsKey ? '' : '(optional)'}</span>
              <input
                className="input"
                type="password"
                autoComplete="off"
                value={adding.apiKey}
                onChange={(e) => setAdding({ ...adding, apiKey: e.target.value })}
                placeholder={adding.preset.needsKey ? 'Paste your key' : 'Not needed for local servers'}
              />
            </label>
            <label className="row small" style={{ marginBottom: 12, flexWrap: 'nowrap', cursor: 'pointer' }}>
              <input type="checkbox" checked={adding.auto} onChange={(e) => setAdding({ ...adding, auto: e.target.checked })} />
              <span>
                <b>Pick the best models for me</b> <span className="muted">(recommended): the strongest for chat, a fast one for background jobs.</span>
              </span>
            </label>
            {!adding.auto && (
              <button className="btn" disabled={busy} onClick={fetchModels} style={{ marginBottom: 12 }}>
                {busy ? <span className="spinner" /> : <Icon name="refresh" size={15} />} Find models
              </button>
            )}
            {!adding.auto && adding.available.length > 0 && (
              <div className="field">
                <label>Models ({adding.models.length} selected)</label>
                <div style={{ maxHeight: 220, overflowY: 'auto', background: 'var(--sunk)', borderRadius: 10, padding: 6 }}>
                  {adding.available.map((m) => (
                    <label key={m} className="row small" style={{ padding: '3px 6px', flexWrap: 'nowrap' }}>
                      <input
                        type="checkbox"
                        checked={adding.models.includes(m)}
                        onChange={(e) => setAdding({ ...adding, models: e.target.checked ? [...adding.models, m] : adding.models.filter((x) => x !== m) })}
                      />
                      {m}
                    </label>
                  ))}
                </div>
              </div>
            )}
            {!adding.auto && (
              <label className="field">
                <span className="label">Or type model ids</span>
                <input
                  className="input"
                  value={adding.manual}
                  onChange={(e) => setAdding({ ...adding, manual: e.target.value })}
                  placeholder="comma separated"
                />
              </label>
            )}
            {err && (
              <div className="error-box" style={{ marginBottom: 12 }}>
                {err}
              </div>
            )}
            <div className="row">
              <button className="btn primary" disabled={busy} onClick={addProvider}>
                {busy && adding.auto ? 'Finding the best models…' : 'Add'}
              </button>
              <button className="btn" onClick={() => (setAdding(null), setErr(''))}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="list-item">
            <select
              aria-label="Add an AI provider"
              className="select"
              value=""
              onChange={(e) => {
                const preset = data.presets.find((p) => p.preset === e.target.value);
                if (preset)
                  setAdding({
                    preset,
                    name: preset.name.replace(/ \(.*\)$/, ''),
                    baseUrl: preset.baseUrl,
                    apiKey: '',
                    models: [],
                    available: [],
                    manual: '',
                    auto: true,
                  });
              }}
            >
              <option value="">Add an API key or local model…</option>
              {data.presets.map((p) => (
                <option key={p.preset} value={p.preset}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </Group>

      {allModels.length > 0 && !compact && (
        <Group
          title="Which model does what"
          foot="Mix and match: a strong model for chat, a vision model for the browser agent, a cheap one for background jobs. If one is busy or down, Errand switches to another connected model by itself."
        >
          {(
            [
              ['chat', 'Chat', 'First available'],
              ['handoff', 'Browser agent', 'Same as chat'],
              ['utility', 'Background jobs', 'Same as chat'],
            ] as const
          ).map(([role, label, fallback]) => (
            <div className="form-row" key={role}>
              <label>{label}</label>
              <select className="select grow" aria-label={label} value={roles[role]} onChange={(e) => setRoles({ ...roles, [role]: e.target.value })}>
                <option value="">{fallback}</option>
                {allModels.map((m) => (
                  <option key={m.ref} value={m.ref}>
                    {m.label}
                  </option>
                ))}
              </select>
              <button
                className="btn sm"
                onClick={async () => {
                  const ref = roles[role] || roles.chat || allModels[0].ref;
                  setTesting({ ...testing, [role]: '…' });
                  try {
                    const r = await api('/providers/test', { body: { ref } });
                    setTesting((t) => ({ ...t, [role]: `✓ ${r.ms} ms` }));
                  } catch (e) {
                    setTesting((t) => ({ ...t, [role]: `✗ ${(e as Error).message.slice(0, 60)}` }));
                  }
                }}
              >
                {testing[role] ?? 'Test'}
              </button>
            </div>
          ))}
          <div className="list-item">
            <button className="btn primary" onClick={() => save({ models: roles })}>
              Save
            </button>
          </div>
        </Group>
      )}
    </>
  );
}

function SearchSettings() {
  const { draft, setDraft, save } = useDraft();
  if (!draft) return null;
  const s = draft.search as AppSettings['search'] & { hasApiKey?: boolean };
  return (
    <Group
      title="Web search"
      foot={
        s.provider === 'google' ? (
          <>
            Real Google results through Serper.dev. Get a free key (2,500 searches) at{' '}
            <a href="https://serper.dev" target="_blank" rel="noreferrer">
              serper.dev
            </a>
            .
          </>
        ) : (
          'DuckDuckGo works without a key. Google, Brave, Tavily or your own SearXNG are more reliable for heavy use.'
        )
      }
    >
      <div className="form-row">
        <label>Provider</label>
        <select
          className="select grow"
          aria-label="Search provider"
          value={s.provider}
          onChange={(e) => setDraft({ ...draft, search: { ...s, provider: e.target.value } })}
        >
          <option value="duckduckgo">DuckDuckGo (no key needed)</option>
          <option value="google">Google</option>
          <option value="brave">Brave Search</option>
          <option value="tavily">Tavily</option>
          <option value="searxng">SearXNG</option>
        </select>
      </div>
      {(s.provider === 'google' || s.provider === 'brave' || s.provider === 'tavily') && (
        <div className="form-row">
          <label>API key</label>
          <input
            className="input grow"
            type="password"
            autoComplete="off"
            value={s.apiKey}
            placeholder={s.hasApiKey ? '•••••••• (saved)' : 'Paste key'}
            onChange={(e) => setDraft({ ...draft, search: { ...s, apiKey: e.target.value } })}
          />
        </div>
      )}
      {s.provider === 'searxng' && (
        <div className="form-row">
          <label>URL</label>
          <input
            className="input grow"
            value={s.url}
            onChange={(e) => setDraft({ ...draft, search: { ...s, url: e.target.value } })}
            placeholder="http://localhost:8080"
          />
        </div>
      )}
      <div className="list-item">
        <button className="btn primary" onClick={() => save({ search: { provider: s.provider, apiKey: s.apiKey, url: s.url } })}>
          Save
        </button>
      </div>
    </Group>
  );
}

// ── Integrations (MCP) ────────────────────────────────────────────────────────

interface McpServer {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string;
  enabled: boolean;
  approval: boolean;
  connected: boolean;
  error: string;
  tools: string[];
}

function IntegrationsSettings() {
  const { toast } = useApp();
  const { data, reload } = useResource<McpServer[]>('/mcp', ['mcp.updated']);
  const [form, setForm] = useState<{ name: string; transport: string; command: string; args: string; env: string; url: string; headers: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const pairs = (s: string, sep: string) =>
    Object.fromEntries(
      s
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const i = l.indexOf(sep);
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }),
    );

  const add = async () => {
    if (!form) return;
    setBusy(true);
    try {
      await api('/mcp', {
        body: {
          name: form.name,
          transport: form.transport,
          command: form.command,
          args: form.args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((a) => a.replace(/^"|"$/g, '')) ?? [],
          env: pairs(form.env, '='),
          url: form.url,
          headers: pairs(form.headers, ':'),
        },
      });
      setForm(null);
      void reload();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sub
      title="Integrations"
      lede="Connect any app through MCP servers: Slack, GitHub, Notion, Linear, Spotify, Strava, Home Assistant and thousands more. Or just ask in chat: “connect my GitHub”."
    >
      <Group
        foot={
          <a href="https://github.com/modelcontextprotocol/servers" target="_blank" rel="noreferrer">
            Browse MCP servers →
          </a>
        }
      >
        {data?.map((s) => (
          <div key={s.id} className="list-item" style={{ alignItems: 'flex-start' }}>
            <span className="icon-chip">
              <Icon name="plug" size={16} />
            </span>
            <div className="grow">
              <div className="row" style={{ gap: 6 }}>
                <span style={{ fontWeight: 500 }}>{s.name}</span>
                {s.connected ? (
                  <span className="tag ok">{s.tools.length} tools</span>
                ) : s.enabled ? (
                  <span className="tag err">not connected</span>
                ) : (
                  <span className="tag">off</span>
                )}
              </div>
              <div className="small muted secret">{s.transport === 'http' ? s.url : `${s.command} ${s.args.join(' ')}`}</div>
              {s.error && (
                <div className="small" style={{ color: 'var(--bad)' }}>
                  {s.error}
                </div>
              )}
            </div>
            <label className="row small muted" style={{ gap: 6, flexWrap: 'nowrap' }} title="Ask before every call">
              Ask first{' '}
              <Switch on={s.approval} label="Ask first" onChange={(v) => api(`/mcp/${s.id}`, { method: 'PATCH', body: { approval: v } }).then(reload)} />
            </label>
            <Switch on={s.enabled} label="Enabled" onChange={(v) => api(`/mcp/${s.id}`, { method: 'PATCH', body: { enabled: v } }).then(reload)} />
            <button className="btn icon sm" onClick={() => confirm(`Remove ${s.name}?`) && api(`/mcp/${s.id}`, { method: 'DELETE' }).then(reload)}>
              <Icon name="trash" size={15} />
            </button>
          </div>
        ))}
        {form ? (
          <div className="list-item" style={{ display: 'block' }}>
            <div className="grid2">
              <label className="field">
                <span className="label">Name</span>
                <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="GitHub" />
              </label>
              <label className="field">
                <span className="label">Type</span>
                <select className="select" aria-label="Type" value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value })}>
                  <option value="stdio">Runs on this computer</option>
                  <option value="http">Remote URL</option>
                </select>
              </label>
            </div>
            {form.transport === 'stdio' ? (
              <>
                <div className="grid2">
                  <label className="field">
                    <span className="label">Command</span>
                    <input className="input" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="npx" />
                  </label>
                  <label className="field">
                    <span className="label">Arguments</span>
                    <input className="input" value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} placeholder="-y some-mcp-server" />
                  </label>
                </div>
                <label className="field">
                  <span className="label">Environment (KEY=value per line)</span>
                  <textarea
                    className="textarea"
                    style={{ minHeight: 60 }}
                    value={form.env}
                    onChange={(e) => setForm({ ...form, env: e.target.value })}
                    placeholder="API_TOKEN=…"
                  />
                </label>
              </>
            ) : (
              <>
                <label className="field">
                  <span className="label">URL</span>
                  <input className="input" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
                </label>
                <label className="field">
                  <span className="label">Headers (Name: value per line)</span>
                  <textarea
                    className="textarea"
                    style={{ minHeight: 60 }}
                    value={form.headers}
                    onChange={(e) => setForm({ ...form, headers: e.target.value })}
                    placeholder="Authorization: Bearer …"
                  />
                </label>
              </>
            )}
            <div className="row">
              <button className="btn primary" disabled={busy || !form.name} onClick={add}>
                {busy ? 'Connecting…' : 'Connect'}
              </button>
              <button className="btn" onClick={() => setForm(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button className="row-link" onClick={() => setForm({ name: '', transport: 'stdio', command: 'npx', args: '', env: '', url: '', headers: '' })}>
            <span className="tile">
              <Icon name="plus" size={15} stroke={2.2} />
            </span>
            <span className="grow">Add an integration</span>
          </button>
        )}
      </Group>
    </Sub>
  );
}

// ── Browser agent ─────────────────────────────────────────────────────────────

function BrowserSettings() {
  const { draft, setDraft, save } = useDraft();
  if (!draft) return null;
  const h = draft.handoff;
  const setH = (p: Partial<AppSettings['handoff']>) => setDraft({ ...draft, handoff: { ...h, ...p } });
  return (
    <Sub title="Browser agent" lede="The agent that works websites for you. It runs a real browser on this computer, or on your own always-on server.">
      <Group>
        <div className="form-row">
          <label>Browser</label>
          <select className="select grow" aria-label="Browser" value={h.browserChannel} onChange={(e) => setH({ browserChannel: e.target.value })}>
            <option value="msedge">Microsoft Edge</option>
            <option value="chrome">Google Chrome</option>
            <option value="chromium">Chromium</option>
            <option value="custom">Custom executable</option>
            <option value="remote">Remote computer (CDP)</option>
          </select>
        </div>
        {h.browserChannel === 'custom' && (
          <div className="form-row">
            <label>Executable</label>
            <input className="input grow" value={h.executablePath} onChange={(e) => setH({ executablePath: e.target.value })} />
          </div>
        )}
        {h.browserChannel === 'remote' && (
          <div className="form-row">
            <label>CDP URL</label>
            <input className="input grow" value={h.cdpUrl} onChange={(e) => setH({ cdpUrl: e.target.value })} placeholder="wss://…" />
          </div>
        )}
        <div className="form-row">
          <label className="grow">Show the browser window</label>
          <Switch on={!h.headless} label="Show the browser window" onChange={(v) => setH({ headless: !v })} />
        </div>
        <div className="form-row">
          <label className="grow">Send screenshots to the model</label>
          <Switch on={h.useVision} label="Send screenshots to the model" onChange={(v) => setH({ useVision: v })} />
        </div>
        <div className="form-row">
          <label>Tasks at once</label>
          <input
            className="input grow"
            type="number"
            min={1}
            max={12}
            value={h.maxConcurrent}
            onChange={(e) => setH({ maxConcurrent: Number(e.target.value) })}
          />
        </div>
        <div className="form-row">
          <label>Max steps per task</label>
          <input className="input grow" type="number" min={5} max={200} value={h.maxSteps} onChange={(e) => setH({ maxSteps: Number(e.target.value) })} />
        </div>
      </Group>
      <div className="group-foot" style={{ marginTop: -14, marginBottom: 22 }}>
        You can always watch a task live and take over from Errand itself, on any browser here, including remote ones. Remote: point at a hosted browser
        (Browserbase, Browserless, Steel…) or run the Errand Docker image, which brings its own.
      </div>
      <Group
        title="Beyond the browser"
        foot="Off by default. When on, Errand can run commands on this computer (open apps, move files, run scripts). You approve every single command."
      >
        <div className="form-row">
          <label className="grow">Allow commands on this computer</label>
          <Switch
            on={draft.computer.allowCommands}
            label="Allow commands on this computer"
            onChange={(v) => setDraft({ ...draft, computer: { allowCommands: v } })}
          />
        </div>
      </Group>
      <button className="btn primary" onClick={() => save({ handoff: h, computer: draft.computer })}>
        Save
      </button>
    </Sub>
  );
}

// ── Notifications ─────────────────────────────────────────────────────────────

function NotificationSettings() {
  const { draft, setDraft, save, toast } = useDraft();
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  if (!draft) return null;
  return (
    <Sub title="Notifications" lede="Hear from Errand when it needs you, finishes a task, or has new suggestions.">
      <Group>
        <div className="form-row">
          <label className="grow">Browser notifications</label>
          {perm === 'default' ? (
            <button className="btn sm" onClick={async () => setPerm(await Notification.requestPermission())}>
              Enable
            </button>
          ) : (
            <span className="value muted">{perm}</span>
          )}
        </div>
        <div className="form-row">
          <label className="grow">Proactive suggestions</label>
          <Switch
            on={draft.proactive.enabled}
            label="Proactive suggestions"
            onChange={(v) => setDraft({ ...draft, proactive: { ...draft.proactive, enabled: v } })}
          />
        </div>
        <div className="form-row">
          <label className="grow">
            Notice things in my email
            <div className="hint">CI failures, orders, bills, trips and job applications, tracked on Home</div>
          </label>
          <Switch
            on={draft.proactive.email}
            label="Notice things in my email"
            onChange={(v) => setDraft({ ...draft, proactive: { ...draft.proactive, email: v } })}
          />
        </div>
        <div className="form-row">
          <label>Check every</label>
          <select
            aria-label="Check every"
            className="select grow"
            value={draft.proactive.intervalMinutes}
            onChange={(e) => setDraft({ ...draft, proactive: { ...draft.proactive, intervalMinutes: Number(e.target.value) } })}
          >
            {[30, 60, 120, 240, 480].map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label className="grow">Read replies aloud</label>
          <Switch on={draft.voice.speakReplies} label="Read replies aloud" onChange={(v) => setDraft({ ...draft, voice: { speakReplies: v } })} />
        </div>
      </Group>
      <Group
        title="Phone push (optional)"
        foot="Install the free ntfy app and subscribe to the same long, random topic, or use your own ntfy server. Pushes are generic (“Errand needs your approval”) and never contain your data."
      >
        <div className="form-row">
          <label>ntfy topic URL</label>
          <input
            className="input grow"
            value={draft.notifications.ntfyUrl}
            onChange={(e) => setDraft({ ...draft, notifications: { ntfyUrl: e.target.value } })}
            placeholder="https://ntfy.sh/your-random-topic"
          />
        </div>
      </Group>
      <div className="row">
        <button className="btn primary" onClick={() => save({ notifications: draft.notifications, proactive: draft.proactive, voice: draft.voice })}>
          Save
        </button>
        <button className="btn" onClick={async () => (await api('/notifications/test', { body: {} }), toast('Test sent'))}>
          Send a test
        </button>
      </div>
    </Sub>
  );
}

// ── Privacy & security ────────────────────────────────────────────────────────

function SecuritySettings() {
  const { draft, setDraft, save, toast } = useDraft();
  const { data: vault } = useVault();
  const [confirmText, setConfirmText] = useState('');
  if (!draft) return null;
  return (
    <Sub
      title="Privacy & security"
      lede="Errand runs on your machine. Your data stays in a local database you control; nothing is sent anywhere except to the AI provider and services you connect."
    >
      <Group title="Vault">
        <div className="form-row">
          <label className="grow">Status</label>
          {vault?.initialized ? (
            vault.unlocked ? (
              <button className="btn sm" onClick={() => api('/vault/lock', { body: {} })}>
                <Icon name="lock" size={13} /> Lock now
              </button>
            ) : (
              <a className="btn sm" href="#/settings/accounts?tab=logins">
                Unlock
              </a>
            )
          ) : (
            <a className="btn sm" href="#/settings/accounts?tab=logins">
              Set up
            </a>
          )}
        </div>
        <div className="form-row">
          <label>Lock after</label>
          <select
            aria-label="Lock after"
            className="select grow"
            value={draft.vault.autoLockMinutes}
            onChange={(e) => (
              setDraft({ ...draft, vault: { autoLockMinutes: Number(e.target.value) } }),
              save({ vault: { autoLockMinutes: Number(e.target.value) } })
            )}
          >
            {[5, 15, 30, 60, 240, 0].map((m) => (
              <option key={m} value={m}>
                {m === 0 ? 'Never' : m < 60 ? `${m} minutes idle` : `${m / 60} hour${m === 60 ? '' : 's'} idle`}
              </option>
            ))}
          </select>
        </div>
      </Group>
      <Group title="How your data is protected">
        <div className="list-item" style={{ display: 'block' }}>
          <ul className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.75 }}>
            <li>
              Logins, cards and API keys are encrypted with AES-256-GCM using a key derived from your passphrase (scrypt). The key exists only in memory while
              unlocked.
            </li>
            <li>AI models never see secrets. They use placeholders that are filled in at the moment of typing, and a login only fills on its own website.</li>
            <li>Paying, sending, booking, deleting and every new site for your card need your approval.</li>
            <li>Text from websites and emails is treated as untrusted. Credentials found in tool results are blocked before the model sees them.</li>
            <li>
              The server rejects cross-site requests and DNS rebinding, blocks the agent from reaching your local network, and panels run sandboxed with no
              network access.
            </li>
          </ul>
        </div>
      </Group>
      <Group title="Your data">
        <a className="row-link" href="/api/data/export" target="_blank" rel="noreferrer">
          <span className="tile">
            <Icon name="copy" size={15} stroke={2} />
          </span>
          <span className="grow">Export all my data</span>
        </a>
        <div className="list-item" style={{ display: 'block' }}>
          <div style={{ fontWeight: 500, color: 'var(--bad)' }}>Delete everything</div>
          <p className="small muted" style={{ margin: '4px 0 10px' }}>
            Permanently erases conversations, memory, projects, the vault, connected accounts, files and the agent’s browser profile. This cannot be undone.
          </p>
          <div className="row">
            <input className="input" style={{ width: 160 }} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="Type DELETE" />
            <button
              className="btn danger"
              disabled={confirmText !== 'DELETE'}
              onClick={async () => {
                await api('/data/delete-all', { body: { confirm: confirmText } });
                toast('All data deleted');
                setTimeout(() => (window.location.href = '/'), 800);
              }}
            >
              Delete all data
            </button>
          </div>
        </div>
      </Group>
    </Sub>
  );
}

// ── About ─────────────────────────────────────────────────────────────────────

interface PhoneStatus {
  enabled: boolean;
  code?: string;
  urls?: { label: string; url: string }[];
  qr?: string | null;
  listening?: boolean;
}

function PhoneSettings() {
  const { toast } = useApp();
  const { data, reload } = useResource<PhoneStatus>('/phone', []);
  const [busy, setBusy] = useState(false);
  const set = async (body: { enabled: boolean; newCode?: boolean }) => {
    setBusy(true);
    try {
      await api('/phone', { body });
      await reload();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!data) return null;
  return (
    <Sub
      title="Use on your phone"
      lede="Open Errand on your phone while it runs on this computer. Everything still happens here; your phone is a remote for it."
    >
      <Group>
        <div className="form-row">
          <label className="grow">Use Errand on my phone</label>
          <Switch on={data.enabled} label="Use Errand on my phone" onChange={(v) => !busy && set({ enabled: v })} />
        </div>
      </Group>
      {data.enabled &&
        (!data.listening ? (
          <Group>
            <div className="list-item">
              Another app is using the port Errand needs for your phone. Close it and turn this off and on again, or set ERRAND_PHONE_PORT to a free port.
            </div>
          </Group>
        ) : data.urls?.length ? (
          <>
            <Group foot="Then add it to your home screen: on iPhone tap Share → Add to Home Screen; on Android tap ⋮ → Add to Home screen.">
              <div className="phone-pair">
                {data.qr && <div className="phone-qr" dangerouslySetInnerHTML={{ __html: data.qr }} />}
                <div>
                  <div className="big">Scan with your phone’s camera</div>
                  <p className="muted small">It opens Errand and signs in. Your phone needs to be on the same Wi-Fi as this computer.</p>
                  <div className="small">
                    Or open <strong>{data.urls[0].url}</strong> and enter <code>{data.code}</code>
                  </div>
                </div>
              </div>
            </Group>
            <Group
              title="Good to know"
              foot="On the phone, voice input and browser notifications need a secure (HTTPS) connection, so they stay on this computer. Typing, approvals, panels and everything else work."
            >
              <div className="list-item" style={{ display: 'block' }}>
                <p className="small" style={{ marginTop: 0 }}>
                  Keep this computer on with Errand running. If Windows asks whether Errand may use your network, choose <strong>Allow</strong> for private
                  networks.
                </p>
                <p className="small" style={{ marginBottom: 0 }}>
                  Away from home? Install the free{' '}
                  <a href="https://tailscale.com/download" target="_blank" rel="noreferrer">
                    Tailscale
                  </a>{' '}
                  app on this computer and your phone, sign in to both, and your phone can reach Errand from anywhere.
                </p>
              </div>
              {data.urls.length > 1 &&
                data.urls.slice(1).map((u) => (
                  <div key={u.url} className="list-item">
                    <span className="grow">{u.label}</span>
                    <span className="muted small">{u.url}</span>
                  </div>
                ))}
            </Group>
            <Group foot="Lost your phone? A new code signs every phone out.">
              <div className="list-item">
                <button
                  className="btn danger"
                  disabled={busy}
                  onClick={() => confirm('Sign every phone out and make a new code?') && set({ enabled: true, newCode: true })}
                >
                  Make a new code
                </button>
              </div>
            </Group>
          </>
        ) : (
          <Group>
            <div className="list-item">This computer isn’t on a Wi-Fi or home network right now. Connect it, then come back here.</div>
          </Group>
        ))}
    </Sub>
  );
}

interface VersionInfo {
  version: string;
  latest: string | null;
  update: boolean;
  releases: string;
  selfUpdate: boolean;
}
const FEEDBACK = 'https://github.com/FurquanEats/errand/issues/new';

function AboutSettings() {
  const { draft, save, toast } = useDraft();
  const [check, setCheck] = useState(false);
  const { data: v, reload } = useResource<VersionInfo>(check ? '/version?check=1' : '/version', []);
  const [updating, setUpdating] = useState(false);
  const { data: startup, reload: reloadStartup } = useResource<{ available: boolean; on: boolean }>('/startup', ['settings.updated']);
  const setStartup = async (on: boolean) => {
    try {
      await api('/startup', { method: 'PUT', body: { on } });
      toast(on ? 'Errand will start when you log in' : 'Errand will not start by itself');
    } catch (err) {
      toast((err as Error).message);
    }
    void reloadStartup();
  };
  const update = async () => {
    try {
      await api('/update', { body: {} });
      setUpdating(true);
    } catch (err) {
      toast((err as Error).message);
    }
  };
  return (
    <Sub title="About Errand">
      {v?.update && (
        <Group
          foot={
            updating
              ? 'Errand is closing to update. It opens again by itself in a minute or two.'
              : v.selfUpdate
                ? 'Errand closes, updates and opens again in a minute or two. Your data stays.'
                : 'Run the Errand installer again to update. Your data stays.'
          }
        >
          <div className="list-item">
            <span className="grow">
              <strong>Errand {v.latest} is available</strong>
            </span>
            <a className="btn sm" href={v.releases} target="_blank" rel="noreferrer">
              What's new
            </a>
            {v.selfUpdate && (
              <button className="btn sm primary" onClick={update} disabled={updating}>
                {updating ? 'Updating…' : 'Update now'}
              </button>
            )}
          </div>
        </Group>
      )}
      <Group>
        <div className="list-item">
          <span className="grow">Version</span>
          <span className="muted">{v ? `${v.version}${v.latest && !v.update ? ' · Up to date' : ''}` : '…'}</span>
          {v && !v.update && (
            <button
              className="btn sm"
              onClick={() => {
                if (check) void reload();
                else setCheck(true);
              }}
            >
              Check now
            </button>
          )}
        </div>
        {startup?.available && (
          <div className="list-item">
            <span className="grow">
              Start Errand when I log in
              <div className="hint">In the background, so it keeps noticing things and running your scheduled tasks after a restart.</div>
            </span>
            <Switch on={startup.on} label="Start Errand when I log in" onChange={(on) => void setStartup(on)} />
          </div>
        )}
        {draft && (
          <div className="list-item">
            <span className="grow">
              Check for updates automatically
              <div className="hint">Asks GitHub for the latest version every few hours. Nothing about you is sent.</div>
            </span>
            <Switch
              on={draft.updates.check}
              label="Check for updates automatically"
              onChange={(on) => void save({ updates: { check: on } }, on ? 'Errand will check for updates' : 'Automatic update checks are off')}
            />
          </div>
        )}
        <RowLink href="https://github.com/FurquanEats/errand/blob/main/CHANGELOG.md" icon="sparkle" label="What's new" />
        <RowLink href={FEEDBACK} icon="chat" label="Send feedback or report a problem" />
      </Group>
      <Group>
        <div className="list-item" style={{ display: 'block' }}>
          <p style={{ marginTop: 0 }}>
            Errand is an open-source personal agent: it chats, remembers you, works websites for you, keeps an eye on your inbox and calendar, and suggests what
            to take care of next, using the AI you already pay for.
          </p>
          <p className="small muted" style={{ marginBottom: 0 }}>
            MIT licensed. Made by{' '}
            <a href="https://zovle.in" target="_blank" rel="noreferrer">
              Zovle
            </a>
            .
          </p>
        </div>
      </Group>
    </Sub>
  );
}
