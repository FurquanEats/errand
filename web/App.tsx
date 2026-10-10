import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api, navigate, useEvents, useResource, useRoute } from './api';
import { Ctx, useApp, type AppSettings } from './context';
import { Feed } from './components/Feed';
import { Chat, MainChat } from './components/Chat';
// Pages beyond the chat load on first visit, so the chat opens without waiting for them.
const ProjectDetail = lazy(() => import('./components/Projects').then((m) => ({ default: m.ProjectDetail })));
const ProjectList = lazy(() => import('./components/Projects').then((m) => ({ default: m.ProjectList })));
const MemoryPage = lazy(() => import('./components/Memory').then((m) => ({ default: m.MemoryPage })));
const ActivityPage = lazy(() => import('./components/Activity').then((m) => ({ default: m.ActivityPage })));
const SettingsPage = lazy(() => import('./components/Settings').then((m) => ({ default: m.SettingsPage })));
const RoutinesPage = lazy(() => import('./components/Routines').then((m) => ({ default: m.RoutinesPage })));
const Onboarding = lazy(() => import('./components/Onboarding').then((m) => ({ default: m.Onboarding })));
import { PendingTray } from './components/Pending';
import { TaskPanel } from './components/TaskPanel';
import { SearchModal } from './components/Search';
import { Icon } from './components/Icon';
import { Mark } from './components/Mark';

export interface Status {
  hasModel: boolean;
  onboarded: boolean;
  userName: string;
  vault: { initialized: boolean; unlocked: boolean };
  phone?: boolean;
}

/** The menu behind your name: the places that aren't the conversation. */
function AccountMenu({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { phone } = useApp();
  const { data: handoffs } = useResource<{ status: string }[]>('/handoffs', ['handoff.created', 'handoff.status']);
  const active = handoffs?.filter((h) => ['running', 'waiting', 'queued'].includes(h.status)).length ?? 0;
  useEffect(() => {
    const off = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', off);
    window.addEventListener('keydown', off);
    return () => {
      window.removeEventListener('mousedown', off);
      window.removeEventListener('keydown', off);
    };
  }, [onClose]);
  const item = (href: string, icon: string, label: string, extra?: string) => (
    <a className="menu-item" role="menuitem" href={`#${href}`} onClick={onClose}>
      <Icon name={icon} size={16} /> <span className="grow">{label}</span>
      {extra && <span className="count">{extra}</span>}
    </a>
  );
  return (
    <div className="account-menu" role="menu" ref={ref}>
      {item('/handoff', 'globe', 'Browser tasks', active ? String(active) : undefined)}
      {item('/routines', 'clock', 'Scheduled tasks')}
      {item('/memory', 'brain', 'Memory')}
      <div className="menu-sep" />
      {item('/settings/accounts', 'key', 'Accounts')}
      {item('/settings', 'settings', 'Settings')}
      {!phone && (
        <>
          <div className="menu-sep" />
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
              if (confirm('Quit Errand? It stops noticing things and running scheduled tasks until you open it again.'))
                void api('/quit', { method: 'POST' }).catch(() => {});
              onClose();
            }}
          >
            <Icon name="logout" size={16} /> <span className="grow">Quit Errand</span>
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Shown when Errand's server can't be reached (it was quit, or the computer is asleep), instead of
 * an empty screen that looks like everything was lost. Reloads by itself once Errand is back.
 */
function Offline({ phone }: { phone?: boolean }) {
  return (
    <div className="overlay offline" role="alertdialog" aria-labelledby="offline-title">
      <div className="offline-card">
        <Mark size={52} />
        <h2 id="offline-title">Errand isn’t running</h2>
        <p>
          Your chats, panels and memory are safe.{' '}
          {phone ? 'Make sure your computer is on and Errand is open there.' : 'Open Errand from its icon on your Desktop or Start menu.'}
        </p>
        <p className="muted">
          <span className="spinner" style={{ width: 12, height: 12 }} /> This window reconnects by itself.
        </p>
      </div>
    </div>
  );
}

function Login({ onDone, phone }: { onDone: () => void; phone: boolean }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  return (
    <div className="overlay">
      <form
        className="modal"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api('/login', { body: { password: pw } });
            onDone();
          } catch (x) {
            setErr((x as Error).message);
          }
        }}
      >
        <h2>{phone ? 'Connect this phone' : 'Errand is locked'}</h2>
        <p className="hint" style={{ marginBottom: 14 }}>
          {phone
            ? 'On your computer, open Errand → Settings → Use on your phone, then scan the code or type it here.'
            : 'Enter the password set in ERRAND_PASSWORD.'}
        </p>
        <input
          className="input"
          type={phone ? 'text' : 'password'}
          placeholder={phone ? 'xxxx-xxxx-xxxx' : ''}
          autoCapitalize="off"
          autoComplete="off"
          aria-label={phone ? 'Phone code' : 'Password'}
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        {err && (
          <div className="error-box" style={{ marginTop: 10 }}>
            {err}
          </div>
        )}
        <div className="foot">
          <button className="btn primary">{phone ? 'Connect' : 'Unlock'}</button>
        </div>
      </form>
    </div>
  );
}

const SECTION: Record<string, string> = {
  projects: 'Projects',
  memory: 'Memory',
  handoff: 'Browser tasks',
  routines: 'Scheduled tasks',
  settings: 'Settings',
  vault: 'Accounts',
};

const partOfDay = () => {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

export function App() {
  const route = useRoute();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [needsLogin, setNeedsLogin] = useState<false | { phone: boolean }>(false);
  const [sideOpen, setSideOpen] = useState(false); // today, as a drawer on a phone
  const [taskOpen, setTaskOpen] = useState(false); // the browser column
  const [taskLive, setTaskLive] = useState(false);
  const [menu, setMenu] = useState(false);
  const [search, setSearch] = useState(false);
  const [toastMsg, setToastMsg] = useState('');
  const [skipOnboarding, setSkipOnboarding] = useState(false);

  const reloadSettings = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([api<AppSettings>('/settings'), api<Status>('/status')]);
      setSettings(s);
      setStatus(st);
      setNeedsLogin(false);
    } catch {
      /* the login handler takes over */
    }
  }, []);

  useEffect(() => {
    void reloadSettings();
    const onLogin = (e: Event) => setNeedsLogin({ phone: !!(e as CustomEvent).detail?.phone });
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearch((s) => !s);
      }
    };
    const onShowTask = () => setTaskOpen(true);
    window.addEventListener('errand:login', onLogin);
    window.addEventListener('keydown', onKey);
    window.addEventListener('errand:show-task', onShowTask);
    return () => {
      window.removeEventListener('errand:login', onLogin);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('errand:show-task', onShowTask);
    };
  }, [reloadSettings]);

  // Brief blips (sleep, a restart) shouldn't flash a warning; a real outage gets a clear screen.
  const [offline, setOffline] = useState(false);
  const offlineTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEvents((e) => {
    if (e.type === 'disconnected') offlineTimer.current ??= setTimeout(() => setOffline(true), 2500);
    if (e.type === 'reconnected') {
      clearTimeout(offlineTimer.current);
      offlineTimer.current = undefined;
      if (offline) location.reload();
    }
    if (e.type === 'settings.updated' || e.type === 'vault.updated') void reloadSettings();
    // A new browser task shows itself.
    if (e.type === 'handoff.created') setTaskOpen(true);
    // A system notification when Errand needs you and you're in another tab or app.
    if (e.type === 'notify' && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(e.title, { body: e.body, icon: '/icon.svg', tag: e.title });
      n.onclick = () => {
        window.focus();
        if (e.url) window.location.href = e.url;
      };
    }
  });

  // A task already running when Errand opens is on screen straight away (on a desktop).
  const sawLive = useRef(false);
  const onLive = useCallback((live: boolean) => {
    setTaskLive(live);
    if (live && !sawLive.current && window.matchMedia('(min-width: 1101px)').matches) setTaskOpen(true);
    sawLive.current ||= live;
  }, []);

  useEffect(() => setSideOpen(false), [route]);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg((m) => (m === msg ? '' : m)), 3500);
  }, []);

  const newChat = async () => {
    try {
      navigate(`/c/${(await api<{ id: string }>('/conversations', { body: {} })).id}`);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const [path, query = ''] = route.split('?');
  const [, section, arg] = path.split('/');
  const onboarding = status && !status.onboarded && !skipOnboarding && (path === '/' || path === '/chat');

  const chatLike = path === '/' || section === 'chat' || section === 'c';
  const onProjects = section === 'projects';
  let center: React.ReactNode;
  if (section === 'c' && arg) center = <Chat key={arg} id={arg} />;
  else if (section === 'projects' && arg) center = <ProjectDetail key={arg} id={arg} />;
  else if (section === 'projects') center = <ProjectList />;
  else if (section === 'memory') center = <MemoryPage />;
  else if (section === 'handoff') center = <ActivityPage />;
  else if (section === 'routines') center = <RoutinesPage />;
  else if (section === 'settings' || section === 'vault')
    center = <SettingsPage page={section === 'vault' ? 'accounts' : arg} query={new URLSearchParams(query)} />;
  else center = <MainChat />;

  const first = settings?.userName?.split(' ')[0];
  const today = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <Ctx.Provider value={{ settings, reloadSettings, toast, phone: status?.phone }}>
      {onboarding ? (
        <main className="page-scroll">
          <Suspense fallback={null}>
            <Onboarding
              status={status}
              onDone={async () => {
                setSkipOnboarding(true);
                await api('/onboarding/done', { method: 'POST' });
                await reloadSettings();
                navigate('/chat');
              }}
            />
          </Suspense>
        </main>
      ) : (
        <div className={`shell${taskOpen ? ' with-task task-open' : ''}${sideOpen ? ' side-open' : ''}`}>
          <aside className="side" aria-label="Today">
            <header className="side-head">
              <a className="wordmark" href="#/chat" aria-label="Errand">
                errand<i>.</i>
              </a>
              <button className="icon-btn" onClick={() => setSearch(true)} aria-label="Search (Ctrl K)" title="Search (Ctrl K)">
                <Icon name="search" size={17} />
              </button>
            </header>
            <div className="side-scroll">
              <div className="today-date">{today}</div>
              <div className="today-hello">
                {partOfDay()}
                {first ? `, ${first}` : ''}.
              </div>
              <Feed onAct={() => setSideOpen(false)} />
            </div>
            <footer className="side-foot menu-anchor">
              <button className="me-btn" onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu}>
                <span className="avatar" aria-hidden="true">
                  {(settings?.userName || 'You').charAt(0).toUpperCase()}
                </span>
                <span className="name">{settings?.userName || 'You'}</span>
              </button>
              <a className="icon-btn" href="#/settings" aria-label="Settings" title="Settings">
                <Icon name="settings" size={17} />
              </a>
              {menu && <AccountMenu onClose={() => setMenu(false)} />}
            </footer>
          </aside>
          <main className="main">
            <h1 className="sr-only">Errand: {SECTION[section ?? ''] ?? 'Chat'}</h1>
            <header className="bar">
              <button className="icon-btn drawer-btn" onClick={() => setSideOpen(true)} aria-label="Today">
                <Icon name="menu" size={19} />
              </button>
              <nav className="sections" aria-label="Sections">
                <a className={chatLike ? 'on' : ''} href="#/chat" aria-current={chatLike ? 'page' : undefined}>
                  Chat
                </a>
                <a className={onProjects ? 'on' : ''} href="#/projects" aria-current={onProjects ? 'page' : undefined}>
                  Projects
                </a>
              </nav>
              <button
                className="icon-btn task-toggle"
                onClick={() => setTaskOpen((o) => !o)}
                aria-label={taskLive ? 'Browser: a task is running' : 'Browser'}
                aria-pressed={taskOpen}
                title="Browser"
              >
                <Icon name="globe" size={18} />
                {taskLive && <span className="live-dot pulse" />}
              </button>
              <button className="btn sm" onClick={newChat} aria-label="New chat">
                <Icon name="plus" size={14} /> <span className="label">New chat</span>
              </button>
            </header>
            {status && !status.hasModel && section !== 'settings' && (
              <div className="banner">
                <span className="grow">Connect your AI to get started: your ChatGPT plan, OpenRouter, an API key or a local model.</span>
                <a className="btn sm primary" href="#/settings/models">
                  Connect
                </a>
              </div>
            )}
            <div className={chatLike ? 'main-body' : 'main-body page-scroll'}>
              <Suspense fallback={null}>{center}</Suspense>
            </div>
          </main>
          <TaskPanel open={taskOpen} onLive={onLive} onClose={() => setTaskOpen(false)} />
          <div className="scrim" onClick={() => (setSideOpen(false), setTaskOpen(false))} />
        </div>
      )}
      <PendingTray route={section === 'c' ? path : chatLike ? '/chat' : path} />
      {search && <SearchModal onClose={() => setSearch(false)} />}
      {needsLogin && <Login phone={needsLogin.phone} onDone={() => location.reload()} />}
      {toastMsg && (
        <div className="toast" role="status">
          {toastMsg}
        </div>
      )}
      {offline && <Offline phone={status?.phone} />}
    </Ctx.Provider>
  );
}
