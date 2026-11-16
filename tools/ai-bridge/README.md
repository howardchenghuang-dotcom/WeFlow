# WeFlow Personal AI — Windows preview

An AI assistant inside the WeFlow preview WebUI (`http://127.0.0.1:18110/ui/`) that answers with **your own ChatGPT plan**, through OpenAI's official Sign in with ChatGPT DevKit. There is no API key input and no metered API fallback. Everything runs on your own Windows computer; the stable WeFlow on port 18108 is never touched.

| Part | Where | What it does |
|---|---|---|
| Backend | `preview-bin\weflow.exe`, port 18110 | Reads WeChat's databases read-only and serves the WebUI |
| AI bridge | Electron, port 18109 | Holds the ChatGPT sign-in, talks to OpenAI, shows the tray icon |
| WebUI | `web\dist` | The AI card in a conversation's side panel |

## Install or update

Needs Node.js 22.12 or later, Git, [bun](https://bun.sh), and the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`) or Rust, for the backend.

```powershell
cd "$env:USERPROFILE\WeFlow-AI\tools\ai-bridge"
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

`install.ps1` installs the bridge's dependencies from `package-lock.json`, clones and builds the DevKit at a pinned commit, builds the WebUI, fetches the backend that GitHub Actions built from this branch (or builds it with cargo), and puts a **WeFlow AI** shortcut on the desktop. Run it again after every `git pull`; quit WeFlow AI first. Options: `-UpdateBackend` fetches the backend again, `-Startup` also starts WeFlow AI in the background when you sign in to Windows, `-NoShortcut` leaves the desktop alone.

Backend builds are kept on GitHub for 90 days. If none is left, the installer prints the command that makes a new one.

## Daily use

1. Double-click **WeFlow AI** on the desktop. It starts the backend and the bridge if they are not running and opens the page, already signed in to the local backend.
2. Open a WeChat conversation and the **AI 助手** card. The first time, the card walks through three steps:
   - **启动本机 AI 服务** — done by the shortcut.
   - **允许这个浏览器使用** — click it, then choose **允许** in the small **WeFlow AI** window the bridge opens. A pairing is granted by you at this computer, never by a web page or another program.
   - **登录 ChatGPT** — OpenAI's own sign-in page opens in a new tab.
3. Ask. Enter sends, Shift+Enter starts a new line. Answers appear as they are written; **停止生成** stops the request at OpenAI too.
4. To stop everything, right-click the green **WeFlow AI** icon in the notification area and choose **退出 WeFlow AI**. That also stops the backend this launcher started (and only that one).

## What is sent to the cloud

- **Your question and the earlier turns of the AI conversation** (at most 8,000 characters of them) go to OpenAI with every question. Earlier answers may quote chat text the AI was given.
- **WeChat text goes only when you tick "本轮附带这个会话的微信聊天片段"**, and only for that one question: the box unticks itself after each send, and the send button says when it is attached. At most 150 text messages of the open conversation, 16,000 characters. No pictures, voice, files, other conversations or WeChat IDs; in a group, the others are sent as "Member 1", "Member 2".
- **Which messages** is chosen in the menu under the box:
  - **自动** (the default): name the time or the topic in the question ("上周聊了什么", "他是怎么说合同的"). The question and the earlier AI turns, with no chat text, are first sent with the request "which part should be read?"; the model answers with dates and/or a keyword, the page checks that answer and reads that part from the local backend. This costs one extra model request per question. When nothing is found there, the latest messages are read instead and the answer says so.
  - **最近的消息**: the latest 30, 80 or 150 text messages.
  - **指定日期或关键词**: a date range, a keyword, or both, filled in by you. A keyword attaches the messages that hold it (the newest thirty) with the two before and after each.
- Under each answer, "本轮读取" says which messages went with it. A period that holds more than 150 messages is read from its beginning; the answer says up to when, and you ask for the rest by naming the remaining dates.
- Requests are made with `store: false`. The AI conversation lives in the page only and is gone on reload. The bridge logs no prompt text.
- The ChatGPT credentials stay in the bridge, encrypted with Windows `safeStorage`. The local backend's access token stays between the launcher, the browser tab and port 18110.

## The "90 days"

- The pairing of **this browser with the local bridge** is an `HttpOnly; SameSite=Strict` cookie that expires 90 days after you allow it, and is not extended silently. Its secret is stored encrypted, so the pairing survives a restart.
- The **ChatGPT sign-in itself** is OpenAI's: the DevKit renews it for as long as OpenAI allows. Revocation, plan changes or OpenAI's security checks can ask you to sign in again sooner. This is not a promise of 90 days without signing in.
- Use `http://127.0.0.1:18110`, not `localhost`: they are different sites to the cookie.

## Which subscriptions can be used

Checked against each provider's own pages on 2026-11-15. A web subscription is not an API entitlement.

| Provider | Usable here | Why |
|---|---|---|
| ChatGPT | Yes | OpenAI's [Sign in with ChatGPT DevKit](https://github.com/openai/sign-in-with-chatgpt-devkit) is for open-source apps on the user's own machine (noncommercial licence) |
| Claude Pro/Max | No | Anthropic allows plan sign-in in its own clients only; third parties may not offer Claude sign-in or relay its credentials |
| Gemini (AI Pro/Ultra) | No | The plan includes no API usage; the Gemini CLI terms forbid third-party software from using its sign-in |
| GLM Coding Plan | No | Only inside the coding tools Zhipu lists; your own app must use the metered API |
| Kimi Code | No | For coding and personal interactive use; not for analysing chat logs |

Usage limits and optional paid overage are the provider's. Keep overage/credits **off** in ChatGPT Settings > Usage if nothing beyond the plan may ever be charged.

## Security boundaries

- The bridge listens on `127.0.0.1:18109` only. It answers one origin, `http://127.0.0.1:18110`, checks the `Host` header (DNS rebinding), requires a custom header on every request and the pairing cookie on everything but pairing itself. Other web sites cannot reach it.
- Origin and headers do not stop a program on this computer, which can send whatever it likes. That is why pairing asks you in a native window, and why the bridge has no other way in (the bearer-token routes of the first builds are removed).
- The launcher shows its token only to the backend it started: it checks that the program on 18110 is this checkout's `preview-bin\weflow.exe` and that it accepts the token.
- The preview backend and a stable WeFlow share one config file and cache (`%APPDATA%\weflow`). They do not share a port.

## Where this comes from

This is a personal fork. Reading WeChat's data, the HTTP API, exports and nearly all of the WebUI are other people's work; the fork adds the AI assistant on top and changes none of the Rust code.

| Layer | Project | Licence |
|---|---|---|
| The original WeFlow desktop app | [hicccc77/WeFlow](https://github.com/hicccc77/WeFlow) | CC BY-NC-SA 4.0 |
| The Rust command-line version of its backend, with the WebUI, which this repository is forked from | [334456777/WeFlow](https://github.com/334456777/WeFlow) | Unlicense |
| ChatGPT sign-in and requests, cloned at install time and not part of this repository | [openai/sign-in-with-chatgpt-devkit](https://github.com/openai/sign-in-with-chatgpt-devkit) | Sign-in with ChatGPT DevKit Noncommercial License |
| Added here: `tools/ai-bridge/`, `web/src/ai/`, the AI card's entry in `web/src/chat/useChatPage.tsx`, `.github/workflows/personal-ai.yml` | this fork | as the repository's `LICENSE` |

Two of those licences are noncommercial, so this fork is for personal, noncommercial use: it is not sold, and it is not offered as a hosted service. The fork's `main` branch is kept identical to the upstream it was forked from; the AI assistant lives on the branch `feat/llm-local-chat-analysis`.

## Development

```powershell
cd tools\ai-bridge
npm run check   # syntax of every bridge file
npm test        # guards, session, HTTP surface, stopping the backend
cd ..\..\web
bun run check   # contract, translations, types, tests, build
```

The HTTP surface is in `server.mjs`, free of Electron, so the tests drive it over a real socket with a fake ChatGPT client. `main.mjs` only wires Electron to it.

This is a personal preview. Do not merge it into the stable branch without running it for real on Windows: sign-in, an answer, a restart.
