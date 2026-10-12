# Changelog

Every change that matters to people using Errand. To update, ask Errand “is there an update?” or use **Settings → About → Update now**; your data stays.

## Unreleased

- **Short email notes.** When a check finds many changes at once, similar ones share a line (“4 applications moved to Assessment: Linear, Vercel, Figma and 1 more”), the AI picks the few worth saying first, and the rest wait on your Home screen. To-dos that didn’t make it into Needs you aren’t announced either.
- A finished browser task always shows its final screen, even when it took a moment to save.

## 1.0.3 · 2026-10-12

- **A short “Needs you”.** When more than six things are waiting, the AI keeps the six that matter most (deadlines, money, travel, real interviews) and quietly drops platform nudges, routine security emails, duplicates and likely scams. To-dos are now only real obligations someone is waiting on.
- **One-page résumés really fit on one page.** Errand measures the PDF and tightens the type to fit (within easy reading sizes); if it still runs long, the AI shortens it and tries again. The Word file uses the same sizing.

## 1.0.2 · 2026-10-12

- **Works with Smart App Control.** On Windows 11 PCs where Smart App Control blocks programs it doesn't know yet, setup now notices and starts Errand with its script launcher instead of failing. If Windows blocks the setup download itself, the README has a one-line PowerShell install that always works.

## 1.0.1 · 2026-10-12

- **Documents in and out.** Attach a PDF or Word file and Errand reads it, whichever AI you use. Ask for a résumé, cover letter, report, itinerary or invoice and it makes a real **PDF and Word** file, and can upload it to a website for you.
- **Sign in once, use it everywhere.** “Sign in to a site” opens Google, your grocery app or a job portal in Errand’s browser with you in control; every later task uses that session. The browser agent now checks it’s signed in before account work, uses your saved logins, Google sign-in or a one-time code, and asks you to take over when it can’t.
- **Orders confirmed properly.** Before placing an order the agent shows the items, the total, the delivery address and the payment method for your OK.
- **Errand understands your email with AI, not rules.** It skims every new email to decide what matters, then reads those: employers rather than job boards, real shops rather than bank boilerplate, duplicates merged. A one-time clean-up tidies what older versions saved.
- **Quieter.** Security emails no longer fill the chat, and only changes that matter (an interview, a delivery, a bill due) get a note.
- **New: follow-up nudges** for applications with no reply after 10 days, and **subscriptions**: ask “what am I subscribed to?”.
- **Your Today column, your way.** Hide any section from its menu, clear “Needs you” in one go, or just ask: “delete all my panels” now does what you mean.
- **Errand’s own window on Windows.** No browser frame: Errand’s bar is the title bar, with minimise, maximise and close beside New chat. Drag it to move, double-click to maximise.
- **Resizable columns.** Drag the edge of Today or the browser to make it wider; double-click to reset.
- **Fixes:** long links no longer push the chat or the browser view off screen; the Start-menu icon shows on Windows; Errand answers job questions from its trackers across every inbox instead of saying it found nothing.

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
