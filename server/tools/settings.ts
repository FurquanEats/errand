import { tool } from 'ai';
import { z } from 'zod';
import { getSettings, saveSettings } from '../settings.ts';
import { publish } from '../bus.ts';
import { geocode } from '../weather.ts';
import { requestApproval } from '../approvals.ts';
import { addServer } from '../connectors/mcp.ts';
import { googleConfigured } from '../connectors/google.ts';
import { microsoftConfigured } from '../connectors/microsoft.ts';
import { listProviders, modelLabel, pickBestModels } from '../llm.ts';
import { versionInfo } from '../updates.ts';
import { canSelfUpdate, canStartAtLogin, quitSoon, setStartsAtLogin, startUpdate, startsAtLogin } from '../lifecycle.ts';
import type { ToolContext } from './index.ts';

/**
 * Run Errand from chat: "call me Sam", "I moved to Denver", "connect my work Gmail",
 * "add my Outlook calendar", "hook up Spotify". Anything that hands Errand new access asks first.
 * Secrets (API keys, passwords) are never accepted in chat; the user is sent to the right screen.
 */
export const settingsTools = (ctx: ToolContext) => ({
  settings_update: tool({
    description:
      'Change the user’s profile or preferences: name, home location, time zone, custom instructions, proactive suggestions, noticing things in email (trackers), reading replies aloud.',
    inputSchema: z.object({
      name: z.string().optional(),
      location: z.string().optional().describe('city name'),
      timezone: z.string().optional().describe('IANA zone, e.g. Asia/Kolkata'),
      custom_instructions: z.string().optional().describe('replaces the existing instructions'),
      proactive: z.boolean().optional(),
      notice_email: z.boolean().optional().describe('notice CI failures, orders, bills, trips and applications in email'),
      speak_replies: z.boolean().optional(),
      check_updates: z.boolean().optional().describe('ask GitHub every few hours whether a newer Errand is out'),
    }),
    execute: async (i) => {
      const s = getSettings();
      const next: Record<string, unknown> = {};
      if (i.name !== undefined) next.userName = i.name;
      if (i.location) {
        const [place] = await geocode(i.location);
        if (!place) return { error: `Could not find "${i.location}"` };
        next.location = { name: place.name, lat: place.lat, lon: place.lon };
        next.timezone = place.timezone || s.timezone;
      }
      if (i.timezone) next.timezone = i.timezone;
      if (i.custom_instructions !== undefined) next.customInstructions = i.custom_instructions;
      if (i.proactive !== undefined || i.notice_email !== undefined)
        next.proactive = { ...s.proactive, enabled: i.proactive ?? s.proactive.enabled, email: i.notice_email ?? s.proactive.email };
      if (i.speak_replies !== undefined) next.voice = { speakReplies: i.speak_replies };
      if (i.check_updates !== undefined) next.updates = { check: i.check_updates };
      saveSettings(next);
      publish({ type: 'settings.updated' });
      return { updated: Object.keys(next) };
    },
  }),

  model_choose: tool({
    description:
      'See which AI models are connected, or switch the model Errand uses ("use Gemini", "switch to gpt-5.6-terra", "use something faster for background jobs"). ' +
      'Omit model to just list them. To connect a new provider, use connect_account instead.',
    inputSchema: z.object({
      model: z.string().optional().describe('a model id or provider name'),
      role: z.enum(['chat', 'browser', 'background', 'all']).default('all'),
    }),
    execute: async ({ model, role }) => {
      const providers = listProviders();
      const s = getSettings();
      if (!model)
        return {
          current: {
            chat: s.models.chat && modelLabel(s.models.chat),
            browser: s.models.handoff && modelLabel(s.models.handoff),
            background: s.models.utility && modelLabel(s.models.utility),
          },
          connected: providers.map((p) => ({ provider: p.name, models: p.models.slice(0, 30) })),
        };
      const q = model.toLowerCase();
      const exact = providers.flatMap((p) => p.models.filter((m) => m.toLowerCase() === q).map((m) => `${p.id}:${m}`))[0];
      const partial = providers.flatMap((p) => p.models.filter((m) => m.toLowerCase().includes(q)).map((m) => `${p.id}:${m}`))[0];
      const byProvider = providers.find((p) => p.name.toLowerCase().includes(q) || p.kind === q);
      const best = byProvider && pickBestModels(byProvider.models);
      const ref = exact || partial || (best ? `${byProvider!.id}:${role === 'background' ? best.fast : best.best}` : '');
      if (!ref) return { error: `No connected model matches "${model}".`, connected: providers.map((p) => p.name) };
      const key = { chat: 'chat', browser: 'handoff', background: 'utility' } as const;
      const models = role === 'all' ? { chat: ref, handoff: '', utility: '' } : { ...s.models, [key[role]]: ref };
      saveSettings({ models });
      publish({ type: 'settings.updated' });
      return { using: modelLabel(ref), for: role };
    },
  }),

  connect_account: tool({
    description:
      'Help the user connect something. Returns a button the user taps (shown in chat). ' +
      'google = Gmail/Calendar/Drive (any number of accounts; pass the address as "site" to pre-select it); microsoft = Outlook, Hotmail, Live or Microsoft 365 mail; email = other mailboxes over IMAP; login = a website login for the browser agent; ' +
      'card = a payment card; chatgpt = sign in with a ChatGPT plan; openrouter = sign in with OpenRouter; phone = use Errand on their phone (QR code); privacy = export or delete all data, vault lock; notifications = phone push and alerts; model = another AI provider key; integration = Slack, Spotify, GitHub… via MCP.',
    inputSchema: z.object({
      service: z.enum([
        'google',
        'email',
        'login',
        'card',
        'api_key',
        'model',
        'chatgpt',
        'openrouter',
        'integration',
        'calendar',
        'phone',
        'privacy',
        'notifications',
        'microsoft',
      ]),
      site: z.string().optional(),
    }),
    execute: async ({ service, site }) => {
      const links: Record<string, { label: string; url: string; note: string }> = {
        google: googleConfigured()
          ? {
              label: site?.includes('@') ? `Connect ${site}` : 'Connect a Google account',
              url: `/api/oauth/google/start${site?.includes('@') ? `?hint=${encodeURIComponent(site)}` : ''}`,
              note: 'Repeat to add more Google accounts.',
            }
          : { label: 'Set up Google sign-in', url: '/#/settings/accounts', note: 'One-time step: add your own Google OAuth client, then connect accounts.' },
        email: {
          label: 'Add a mailbox',
          url: '/#/settings/accounts',
          note: 'Works with iCloud, Fastmail, Zoho, Yahoo or any IMAP server, using an app password. For Outlook or Hotmail, connect Microsoft instead.',
        },
        login: {
          label: site ? `Save your ${site} login` : 'Save a login',
          url: `/#/settings/accounts?tab=logins${site ? `&site=${encodeURIComponent(site)}` : ''}`,
          note: 'Encrypted in the vault. Models never see it.',
        },
        card: { label: 'Add a card to Wallet', url: '/#/settings/wallet', note: 'Encrypted in the vault. Used only after you approve a purchase.' },
        api_key: {
          label: site ? `Add your ${site} API key` : 'Add an API key',
          url: `/#/settings/accounts?tab=keys${site ? `&site=${encodeURIComponent(site)}` : ''}`,
          note: 'Stored encrypted and only ever sent to that service. Never paste keys in chat.',
        },
        model: { label: 'Add an AI provider', url: '/#/settings/models', note: 'Paste your API key there, never in chat.' },
        chatgpt: { label: 'Continue with ChatGPT', url: '/api/oauth/chatgpt/start?from=chat', note: 'Uses your ChatGPT plan. No API key needed.' },
        openrouter: {
          label: 'Continue with OpenRouter',
          url: '/api/oauth/openrouter/start?from=chat',
          note: 'One sign-in gives access to hundreds of models.',
        },
        integration: { label: 'Add an integration', url: '/#/settings/integrations', note: 'Or tell me the MCP server command and I can add it for you.' },
        microsoft: microsoftConfigured()
          ? {
              label: 'Continue with Microsoft',
              url: `/api/oauth/microsoft/start${site?.includes('@') ? `?hint=${encodeURIComponent(site)}` : ''}`,
              note: 'Outlook, Hotmail and Microsoft 365, without an app password.',
            }
          : {
              label: 'Set up Microsoft sign-in',
              url: '/#/settings/accounts',
              note: 'One-time step: add a Microsoft app client id, then connect Outlook or Hotmail.',
            },
        phone: { label: 'Set up your phone', url: '/#/settings/phone', note: 'Scan a QR code and Errand opens on your phone.' },
        privacy: { label: 'Privacy & security', url: '/#/settings/security', note: 'Export everything, delete everything, or change when the vault locks.' },
        notifications: { label: 'Notifications', url: '/#/settings/notifications', note: 'Browser alerts and optional phone push.' },
        calendar: { label: 'Add a calendar', url: '/#/settings/accounts', note: 'Connect Google, or give me an iCal (.ics) link and I’ll add it.' },
      };
      return { action: links[service] };
    },
  }),

  calendar_add_feed: tool({
    description: 'Subscribe to a calendar by its iCal (.ics) link (asks first).',
    inputSchema: z.object({ name: z.string(), url: z.string() }),
    execute: async ({ name, url }) => {
      const ok = await requestApproval({ title: 'Add this calendar?', detail: `${name}\n${url}`, conversationId: ctx.conversationId }, ctx.signal);
      if (!ok) return { added: false };
      saveSettings({ calendars: [...getSettings().calendars, { name, url }] });
      publish({ type: 'settings.updated' });
      return { added: true };
    },
  }),

  folder_share: tool({
    description: 'Give Errand access to a folder on this computer (asks first).',
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }) => {
      const ok = await requestApproval(
        {
          title: 'Share this folder with Errand?',
          detail: `Errand will be able to read files in:\n${path}\n(and write, each time with your approval)`,
          conversationId: ctx.conversationId,
        },
        ctx.signal,
      );
      if (!ok) return { shared: false };
      saveSettings({ files: { roots: [...new Set([...getSettings().files.roots, path])] } });
      publish({ type: 'settings.updated' });
      return { shared: true };
    },
  }),

  app_about: tool({
    description:
      'Errand itself: which version is running, whether an update is out and how to install it, what is new, and how Errand runs (in the background; the icon reopens the window). Use for "is there an update?", "what version am I on?", "how do I update?".',
    inputSchema: z.object({}),
    execute: async () => {
      const v = await versionInfo(true);
      return {
        ...v,
        changelog: 'https://github.com/FurquanEats/errand/blob/main/CHANGELOG.md',
        how_to_update: canSelfUpdate()
          ? 'Errand can update itself: call app_update (it asks the user first, then closes, updates and reopens; data stays).'
          : process.platform === 'win32'
            ? 'Download and open https://github.com/FurquanEats/errand/releases/latest/download/Errand-Setup.exe. It closes Errand, updates it and opens it again; data stays.'
            : 'In Terminal run: curl -fsSL https://raw.githubusercontent.com/FurquanEats/errand/main/scripts/install.sh | bash. It closes Errand, updates it and opens it again; data stays.',
        running:
          'Errand keeps running in the background so it can notice things and run scheduled tasks. Closing its window does not stop it; the Errand icon reopens it; Quit Errand in the menu (or the Errand icon by the clock on Windows) stops it.',
      };
    },
  }),

  app_update: tool({
    description:
      'Install the latest version of Errand now: it closes, updates and opens again in a minute or two; chats and settings stay. Check app_about first that an update is out. Asks first.',
    inputSchema: z.object({}),
    execute: async () => {
      if (!canSelfUpdate()) return { updated: false, note: 'This copy of Errand cannot update itself; give the how_to_update steps from app_about.' };
      const v = await versionInfo(true);
      const ok = await requestApproval(
        {
          title: v.update ? `Update Errand to ${v.latest}?` : 'Reinstall Errand?',
          detail: 'Errand closes, installs the latest version and opens again in a minute or two. Your chats, memories and settings stay.',
          conversationId: ctx.conversationId,
        },
        ctx.signal,
      );
      if (!ok) return { updated: false };
      // Give this reply a moment to reach the window before the installer closes Errand.
      setTimeout(() => startUpdate(), 2000);
      return { updating: true, note: 'The installer is starting. Errand closes, updates and opens again by itself.' };
    },
  }),

  app_start_at_login: tool({
    description:
      'Whether Errand starts by itself (in the background, no window) when the user logs in to their computer, and turn that on or off. Leave "on" out to just check. Starting at login keeps noticing things and scheduled tasks going after a restart.',
    inputSchema: z.object({ on: z.boolean().optional() }),
    execute: async ({ on }) => {
      if (!canStartAtLogin()) return { available: false, note: 'Only installs made with the Errand installer can start at login.' };
      if (on !== undefined && !setStartsAtLogin(on)) return { error: 'Could not change it.' };
      publish({ type: 'settings.updated' });
      return { startsAtLogin: startsAtLogin() };
    },
  }),

  app_quit: tool({
    description: 'Quit Errand (stops noticing things and running scheduled tasks until the user opens it again). Asks first.',
    inputSchema: z.object({}),
    execute: async () => {
      const ok = await requestApproval(
        {
          title: 'Quit Errand?',
          detail: 'It stops noticing things and running scheduled tasks until you open it again from its icon.',
          conversationId: ctx.conversationId,
        },
        ctx.signal,
      );
      if (!ok) return { quit: false };
      // Give this reply a moment to reach the window first.
      quitSoon(3000);
      return { quit: true, note: 'Errand closes in a few seconds. Open it again from its icon.' };
    },
  }),

  integration_add: tool({
    description:
      'Connect an MCP server (Slack, Spotify, Strava, GitHub, Notion, Home Assistant…). Local servers run a command on this computer, so the user approves the exact command. ' +
      'Never put API tokens in env yourself; leave them empty and tell the user to fill them in Settings → Integrations.',
    inputSchema: z.object({
      name: z.string(),
      command: z.string().optional().describe('e.g. npx'),
      args: z.array(z.string()).optional(),
      url: z.string().optional().describe('for remote (HTTP) MCP servers'),
    }),
    execute: async ({ name, command, args, url }) => {
      const detail = url ? `Remote server: ${url}` : `This command will run on your computer:\n${command} ${(args ?? []).join(' ')}`;
      const ok = await requestApproval({ title: `Connect ${name}?`, detail, conversationId: ctx.conversationId }, ctx.signal);
      if (!ok) return { added: false };
      await addServer(url ? { name, transport: 'http', url } : { name, transport: 'stdio', command, args });
      return { added: true, note: 'Its tools are available from the next message.' };
    },
  }),
});
