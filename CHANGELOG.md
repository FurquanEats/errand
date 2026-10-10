# Changelog

Every change that matters to people using Errand. To update, ask Errand “is there an update?” or use **Settings → About → Update now**; your data stays.

## 1.0.0 · 2026-10-11

The first stable release: the free, open-source Hark.

**What Errand does**

- **Notices things on its own.** New email is read every 15 minutes and turned into one-tap actions: a CI run that keeps failing, a bill or renewal coming up, a flight to check in for, a trip with no hotel, a to-do someone emailed you, a sign-in you should check, and the habits it learns (“your usual from Zomato on Fridays?”). It always asks before paying.
- **Trackers that keep themselves up to date.** Job applications (including ones you emailed), orders and deliveries, bills and renewals, and trips, built from your email. You hear about changes in chat, on your phone and, on Windows, as notifications from the icon by the clock.
- **A browser agent you can watch and take over.** It works real websites: signs in with your saved logins, fills forms, uploads your files, compares and checks out, and finds verification codes in your inbox. Watch it live in Errand; **take over** with your own mouse and keyboard to sign in or pick something, then **hand it back** and it carries on. It stops before paying, booking, sending or deleting until you say yes. Several tasks run at once.
- **One chat for everything**, with panels, scheduled tasks, projects, memory you can edit, presentations, charts, voice and every MCP integration. Almost every setting can be changed by just asking.
- **Your AI, your computer.** Your ChatGPT plan, OpenRouter, any API key or a local model. Everything stays on your computer. If one AI is busy or down, Errand switches to another.
- **On your phone** over your Wi-Fi or Tailscale, with a QR code.

**New since 0.2**

- **A new look: paper, ink and one signal colour.** A calm Today column (what needs you, weather, trackers and panels), the conversation in the middle, and the browser on the right only while a task is on. New typeface (Host Grotesk), a new mark, and a new deck style for presentations. Every screen passes an automated accessibility check, light and dark, on a computer and a phone.
- **Live view and take over.** The task's browser streams to Errand in real time, and only while you're watching. Take over, hand back, or make the screen bigger.
- **Uploads.** Attach a file in chat (a CV, say) and the browser agent can upload it to a site.
- **Faster, steadier browsing.** The agent waits for each page to settle instead of a fixed pause, and notices when it's going round in circles.
- **Clearer approvals.** Requests say exactly what will happen (“Click ‘Place order’?” on kilnandco.com), with **See the page** next to them.
- **A real Windows app.** `Errand-Setup.exe`, an icon by the clock, notifications with the window closed, **Start with Windows**, one-click updates, and uninstall from Windows Settings that keeps your data unless you say otherwise.
- **Start when you log in**, on Windows, Mac and Linux.
- **Safer.** API keys can't be tricked into going to a look-alike address or follow a redirect to another site; Gmail filters need your OK; a paired phone can't run programs, share folders or export your data.
- **A privacy page.** [PRIVACY.md](PRIVACY.md) lists everything Errand sends and where.
- **Fixes:** clicking the icon right after quitting now starts Errand again; `npm run dev` opens properly; the chat stays scrolled to a new request.
