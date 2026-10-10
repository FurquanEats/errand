import { useState } from 'react';
import { api, useResource } from '../api';
import { useApp } from '../context';
import { MAIL_PRESETS, ModelSettings } from './Settings';
import { Icon } from './Icon';
import type { Status } from '../App';

/**
 * First run, three short steps: who you are, which AI to use, and your email (the thing that
 * makes Errand genuinely useful). Every step can be skipped and done later from chat.
 */
export function Onboarding({ status, onDone }: { status: Status; onDone: () => void }) {
  const { reloadSettings, settings } = useApp();
  // Resume where the user left off, e.g. after returning from "Continue with ChatGPT".
  const [step, setStep] = useState(!status.userName ? 0 : !status.hasModel ? 1 : 2);
  const [name, setName] = useState(status.userName ?? '');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ name: string; lat: number; lon: number; timezone: string }[]>([]);
  const [loc, setLoc] = useState<{ name: string; lat: number; lon: number; timezone: string } | null>(null);
  const { data: providers } = useResource<{ providers: unknown[] }>('/providers', ['settings.updated']);
  const [mail, setMail] = useState({ address: '', password: '' });
  const [connecting, setConnecting] = useState(false);
  const [mailError, setMailError] = useState('');
  const provider = mailProvider(mail.address);

  const connectMail = async (password = mail.password) => {
    if (!provider) return;
    setConnecting(true);
    setMailError('');
    try {
      await api('/accounts/email', {
        body: { ...MAIL_PRESETS[provider.preset], address: mail.address.trim(), password: password.replace(/\s+/g, ''), displayName: name.trim() },
      });
      onDone();
    } catch (e) {
      setMailError((e as Error).message);
    } finally {
      setConnecting(false);
    }
  };
  const g = settings?.google;

  const find = async () => setResults(await api(`/geocode?q=${encodeURIComponent(q)}`));

  const saveProfile = async () => {
    await api('/settings', {
      method: 'PUT',
      body: { userName: name.trim(), ...(loc ? { location: { name: loc.name, lat: loc.lat, lon: loc.lon }, timezone: loc.timezone } : {}) },
    });
    if (name.trim()) await api('/memories', { body: { content: `Name is ${name.trim()}`, category: 'profile' } });
    if (loc) await api('/memories', { body: { content: `Lives in ${loc.name}`, category: 'places' } });
    await reloadSettings();
    setStep(1);
  };

  return (
    <div className="onb">
      <div className="wordmark">
        errand<i>.</i>
      </div>
      <header className="rise">
        <div className="onb-steps" role="img" aria-label={`Step ${step + 1} of 3`}>
          {[0, 1, 2].map((i) => (
            <span key={i} className={i < step ? 'done' : i === step ? 'now' : ''} />
          ))}
        </div>
        <h1>{step === 0 ? 'Welcome to Errand' : step === 1 ? 'Pick your AI' : 'Connect your email'}</h1>
        <p className="lede">
          {step === 0
            ? 'It notices what needs doing in your email and gets it done on real websites, asking before it pays or sends anything. Free, open source, and it runs on your computer.'
            : step === 1
              ? 'Use your ChatGPT plan, OpenRouter, any API key, or a model running on this computer.'
              : 'Email is central to your life. With it, Errand learns what matters, catches verification codes, and comes back with things it can take off your plate.'}
        </p>
      </header>

      {step === 0 && (
        <div className="onb-body rise">
          <label className="field">
            <span className="label">What should I call you?</span>
            <input
              className="input"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your first name"
              onKeyDown={(e) => e.key === 'Enter' && saveProfile()}
            />
          </label>
          <div className="field">
            <label>Where are you based?</label>
            <div className="row">
              <input
                className="input grow"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={loc?.name ?? 'City'}
                onKeyDown={(e) => e.key === 'Enter' && find()}
              />
              <button className="btn" onClick={find}>
                Find
              </button>
            </div>
            {results.map((r) => (
              <button
                key={`${r.lat},${r.lon}`}
                className="btn ghost sm"
                style={{ justifyContent: 'flex-start' }}
                onClick={() => (setLoc(r), setResults([]), setQ(''))}
              >
                {r.name}
              </button>
            ))}
            {loc && <span className="hint">{loc.name}</span>}
          </div>
          <button className="btn primary wide" onClick={saveProfile}>
            Continue
          </button>
        </div>
      )}

      {step === 1 && (
        <div className="onb-body rise">
          <ModelSettings compact onAdded={() => setStep(2)} />
          {!!providers?.providers.length && (
            <button className="btn primary wide" onClick={() => setStep(2)}>
              Continue
            </button>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="onb-body rise">
          {g?.clientId && g.hasClientSecret && (
            <a className="chatgpt-btn" href="/api/oauth/google/start" style={{ justifyContent: 'center' }}>
              <Icon name="mail" size={17} /> Connect Google (Gmail, Calendar, Drive)
            </a>
          )}
          <div>
            <label className="field">
              <span className="label">Your email address</span>
              <input
                className="input"
                type="email"
                autoFocus
                value={mail.address}
                onChange={(e) => setMail({ ...mail, address: e.target.value })}
                placeholder="you@gmail.com"
              />
            </label>
            {provider && (
              <>
                <ol className="small muted" style={{ paddingLeft: 18, lineHeight: 1.7, margin: '0 0 12px' }}>
                  <li>
                    <a href={provider.url} target="_blank" rel="noreferrer">
                      Create an app password at {provider.name}
                    </a>
                    . {provider.note}
                  </li>
                  <li>
                    Copy it and paste it below; Errand connects as soon as you paste. It only lets Errand read and send your email, and you can revoke it any
                    time.
                  </li>
                </ol>
                <label className="field">
                  <span className="label">App password</span>
                  <input
                    className="input"
                    type="password"
                    autoComplete="off"
                    value={mail.password}
                    onChange={(e) => setMail({ ...mail, password: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && mail.password && connectMail()}
                    onPaste={(e) => {
                      // App passwords have a known shape (Google and Yahoo: 16 letters; iCloud: xxxx-xxxx-xxxx-xxxx). Connect on paste.
                      const pasted = e.clipboardData.getData('text').trim();
                      if (/^([a-z]{4}[\s-]?){3}[a-z]{4}$/i.test(pasted)) {
                        e.preventDefault();
                        setMail({ ...mail, password: pasted });
                        void connectMail(pasted);
                      }
                    }}
                  />
                </label>
                {mailError && (
                  <p className="small" style={{ color: 'var(--bad)', marginTop: 0 }}>
                    {mailError}
                  </p>
                )}
                <button className="btn primary wide" disabled={connecting || !mail.password} onClick={() => connectMail()}>
                  {connecting ? 'Connecting…' : 'Connect'}
                </button>
              </>
            )}
            {!provider && MICROSOFT_DOMAINS.includes(mail.address.trim().toLowerCase().split('@')[1] ?? '') && settings?.microsoft?.ready && (
              <a className="btn primary wide" href={`/api/oauth/microsoft/start?hint=${encodeURIComponent(mail.address.trim())}`}>
                Continue with Microsoft
              </a>
            )}
            {!provider &&
              !(MICROSOFT_DOMAINS.includes(mail.address.trim().toLowerCase().split('@')[1] ?? '') && settings?.microsoft?.ready) &&
              mail.address.includes('@') &&
              /\.[a-z]{2,}$/i.test(mail.address.trim()) && (
                <p className="small muted" style={{ margin: 0 }}>
                  For this address, use{' '}
                  <a href="#/settings/accounts" onClick={onDone}>
                    email settings
                  </a>{' '}
                  {MICROSOFT_DOMAINS.includes(mail.address.trim().toLowerCase().split('@')[1] ?? '')
                    ? 'to set up Microsoft sign-in, which Outlook and Hotmail need instead of an app password.'
                    : 'to connect with Google sign-in or your provider’s mail server details.'}
                </p>
              )}
          </div>
          <div className="row">
            <button className="btn ghost" onClick={() => setStep(1)}>
              Back
            </button>
            <span className="spacer" />
            <button className="btn" onClick={onDone}>
              Skip for now
            </button>
          </div>
          <p className="hint">You can connect more accounts any time, or just say “connect my work email” in chat.</p>
        </div>
      )}
    </div>
  );
}

/** Providers that support app passwords for mail, keyed by address domain. */
const APP_PASSWORD_PROVIDERS: { domains: string[]; name: string; preset: string; url: string; note: string }[] = [
  {
    domains: ['gmail.com', 'googlemail.com'],
    name: 'Google',
    preset: 'Gmail (app password)',
    url: 'https://myaccount.google.com/apppasswords',
    note: 'Name it “Errand”. Google asks you to turn on 2-Step Verification first if it isn’t already.',
  },
  {
    domains: ['icloud.com', 'me.com', 'mac.com'],
    name: 'Apple',
    preset: 'iCloud',
    url: 'https://account.apple.com/account/manage',
    note: 'Open Sign-In and Security, then App-Specific Passwords.',
  },
  {
    domains: ['yahoo.com', 'ymail.com', 'rocketmail.com'],
    name: 'Yahoo',
    preset: 'Yahoo',
    url: 'https://login.yahoo.com/myaccount/security/app-password',
    note: 'Name it “Errand”.',
  },
  { domains: ['zoho.com', 'zohomail.com', 'zoho.in'], name: 'Zoho', preset: 'Zoho', url: 'https://accounts.zoho.com/home#security/app_password', note: '' },
  {
    domains: ['fastmail.com', 'fastmail.fm'],
    name: 'Fastmail',
    preset: 'Fastmail',
    url: 'https://app.fastmail.com/settings/security/apps',
    note: 'Give it mail access.',
  },
];

const MICROSOFT_DOMAINS = ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'outlook.in', 'hotmail.co.uk', 'live.in'];

function mailProvider(address: string) {
  const domain = address.trim().toLowerCase().split('@')[1];
  return domain ? APP_PASSWORD_PROVIDERS.find((p) => p.domains.includes(domain)) : undefined;
}
