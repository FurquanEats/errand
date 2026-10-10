# Contributing to Errand

Thanks for helping make a personal agent that belongs to its users. Issues, ideas and pull requests are welcome.

## Getting started

```bash
git clone https://github.com/FurquanEats/errand.git
cd errand
npm install
npm run dev        # server on :4747, web app with hot reload on :5173
```

Open http://localhost:5173 and connect a model (a local Ollama model is the cheapest way to develop).

## Before you open a pull request

```bash
npm run typecheck
npm test
npm run test:e2e   # needs Chrome or Edge for the browser-agent checks
npm run format
```

- Keep pull requests focused. One feature or fix per PR is easiest to review.
- Match the surrounding style: small modules, comments that explain _why_, no clever one-liners.
- Anything that lets the assistant act in the real world must go through an approval (`requestApproval`) and must never hand secret values to a model. See [SECURITY.md](SECURITY.md).
- New tools live in `server/tools/`. Give them clear descriptions: the model reads them.
- UI follows the design system at the top of `web/styles.css`: paper, ink and one vermilion signal for things that are live or need you, hairline rules rather than boxes, type for hierarchy. Check light and dark, a phone and a desktop.

## Project layout

```
server/
  index.ts           HTTP server, background jobs
  routes.ts          REST API
  chat.ts            conversation runs, system prompt
  llm.ts             model providers (any API key, ChatGPT plan, local models)
  tools/             everything the assistant can do
  handoff/           the browser agent (agent.ts), its browser, and the live view and take over (live.ts)
  connectors/        email, calendar, Google, MCP, files, web, ChatGPT/OpenRouter sign-in
  vault.ts           encrypted logins, cards, API keys
  security.ts        CSRF / DNS-rebinding / SSRF guards, secret redaction
  memory.ts, projects.ts, routines.ts, panels.ts, actions.ts, brief.ts
web/
  App.tsx            single-page layout
  components/        chat, feed, panels, settings, …
test/                node:test suites
```

## Reporting bugs

Open an issue with what you did, what you expected and what happened. Logs from the terminal help. Never paste API keys, passwords or personal data.

Security issues: please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
