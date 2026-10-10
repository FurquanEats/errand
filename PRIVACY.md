# Privacy

Errand runs on your own computer. There is no Errand account, no analytics, no telemetry and no server run by us. Your chats, memories, trackers, saved passwords and settings stay in Errand's data folder (`%LOCALAPPDATA%\Errand\data` on Windows, `~/Errand/data` on a Mac or Linux) until you delete them. **Settings → Privacy & security** exports or deletes all of it.

## What Errand sends, and where

Errand only talks to services you choose, plus the few listed under [On its own](#on-its-own).

**Services you set up**

- **Your AI provider** (ChatGPT, OpenRouter, OpenAI, Gemini, Anthropic, Groq, Mistral, DeepSeek, xAI, a local model or any address you enter). Your messages go to it, along with what Errand needs to answer them, such as the emails, pages or files the answer is about. When Errand notices things in your email, it sends the sender, subject and opening lines of new emails that look like bills, orders, trips, applications or to-dos to your **background model** to sort them. Saved passwords and card numbers are never sent to any AI; the AI sees placeholders.
- **Your email and calendar accounts** (IMAP mail, Google, Microsoft and calendar links you add): Errand reads and, when you approve, sends mail through them.
- **Websites the browser agent visits** for your tasks, and the **search engine** you pick in Settings (DuckDuckGo by default, with Wikipedia as a fallback).
- **Anything else you connect**: integrations (MCP servers), phone notifications through an ntfy address, or a remote browser.

**On its own**

| What                                                     | Where                                         | What is sent                                            | How to turn it off                                       |
| -------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| Update check, at most every 6 hours                      | `api.github.com`                              | Nothing about you (a request for the latest version)    | Settings → About → **Check for updates automatically**   |
| Weather for your home city on Home                       | `api.open-meteo.com`                          | Your home city's coordinates                            | Leave your home city empty in Settings → Profile         |
| Looking up a city you type                               | `geocoding-api.open-meteo.com`, OpenStreetMap | The place name you typed                                | Only happens when you set a place or ask about one       |
| Whether a failing CI run has since passed (public repos) | `api.github.com`                              | The name of the repository from a CI email you received | Settings → Notifications → **Notice things in my email** |

**When you install or update**

The installer downloads Errand from `github.com`, its building blocks from the npm registry (`registry.npmjs.org`), and, if your computer doesn't have it, Node.js from `nodejs.org`. It sends nothing about you.

## Questions

Open an issue at [github.com/FurquanEats/errand/issues](https://github.com/FurquanEats/errand/issues). For anything sensitive, see [SECURITY.md](SECURITY.md).
