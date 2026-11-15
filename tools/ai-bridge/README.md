# WeFlow Personal AI — Windows development preview

The WeFlow API v3 preview at `http://127.0.0.1:18110/ui/` can now control official ChatGPT sign-in and conversation analysis without manually copying a bearer token. ChatGPT subscription usage must be eligible under the official DevKit; API key billing is never a fallback.

## After updating the existing checkout

You already have the matching Rust backend on port 18110 and the official DevKit at `tools/ai-bridge/siwc-devkit`. Do not overwrite the original stable backend on port 18108.

1. Close any older `WeFlow AI · ChatGPT Pro` window and stop its previous background process on port 18109.
2. In a new PowerShell:

```powershell
cd "$env:USERPROFILE\WeFlow-AI"
git switch feat/llm-local-chat-analysis
git pull --ff-only
cd web
bun install --frozen-lockfile
bun run check
cd ..\tools\ai-bridge
npm install
npm test
npm start
```

3. Keep the 18109 bridge PowerShell running. The bridge runs **without an Electron window** by default. It opens your normal browser during sign-in.
4. With the existing API v3 server still running on port 18110, **refresh** `http://127.0.0.1:18110/ui/` (use the token-bearing URL supplied by your local backend if it asks).
5. Choose a WeChat conversation and open the AI card.
6. Click **启用本机 AI 登录** (first run only) and choose **允许** in the small **WeFlow AI** window the bridge opens: a pairing is granted by you at this computer, not by the web page. Then click **使用 ChatGPT 登录** and complete the official browser authorization. After that the model list loads automatically. You will not need to copy a bridge token.
7. For automatic bridge startup after Windows sign-in, run once from `tools\ai-bridge`:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-startup.ps1
```

The shortcut is created in **the current user's Startup folder**. Delete `WeFlow Personal AI Bridge.lnk` from Startup to undo.

## 90-day behavior

- The browser-to-local-bridge pairing cookie is `HttpOnly; SameSite=Strict`, scoped to `/ai-auth`, and expires no later than 90 days after you pair.
- Its secret is saved *encrypted* in Electron's Windows OS-protected `safeStorage`, enabling recovery after a bridge restart.
- The underlying OpenAI OAuth refresh tokens are managed by the official local SDK, not by our 90-day cookie. Account revocation, SDK token expiration, subscription changes or provider security checks can require signing in earlier. **This is not a guarantee of 90 days of uninterrupted provider login.**
- The browser pairing works at **127.0.0.1**, not `localhost`, because the latter is a different cookie site.
- Disconnect removes the local pairing and invokes the SDK's account disconnect operation.
- Only explicitly selected text (up to 80 messages, 12,000 characters from the newest 200 entries of the selected session) is sent to the cloud after opt-in. The opt-in covers one question: the box is unticked after each send. Earlier AI answers, which may quote or summarise that text, stay part of the follow-up context until the AI conversation is cleared.
- Stopping an answer in the page also stops the model request in the bridge.

## Supported subscriptions

| Provider | In-app subscription login | Notes |
|---|---|---|
| ChatGPT | Available for testing | Official Sign In With ChatGPT DevKit, plan/usage restrictions apply |
| Claude | Not enabled | A compliant subscription authorization for this third-party use is not verified |
| Gemini | Not enabled | A compliant subscription authorization for this use is not verified |
| GLM | Not enabled | Coding Plan eligibility for generic chat analysis is not verified |
| Kimi | Not enabled | Kimi Code plan eligibility for generic chat analysis is not verified |

There is **no API key input**, paid API fallback, browser scraping or cookie extraction for these services. Subscription quotas, model eligibility and any optional paid overages are controlled by the providers. Keep overage/credits **off** in your ChatGPT account settings if strict no-additional-payment is required.

## Security boundaries

The bridge listens only on 127.0.0.1:18109; the browser authenticated routes are limited to `http://127.0.0.1:18110`, with a restricted custom request header and 90-day HttpOnly cookie. The process enforces local origins, validates model eligibility, and rate-limits cloud requests. Unlike the previous version, no bearer token is exposed to the web UI. Legacy bearer-token routes remain available for backward compatibility.

This is still a draft development build until a real Windows user confirms the full sign-in, browser-cookie restoration and a real AI response. Do not merge into the stable branch or assume unrelated subscription services are available.


## One-click desktop shortcut (Windows)

From PowerShell after pulling this development branch:

```powershell
cd "$env:USERPROFILE\WeFlow-AI"
git switch feat/llm-local-chat-analysis
git pull --ff-only
cd tools\ai-bridge
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-desktop.ps1
```

This creates a shortcut named **WeFlow AI** on your current Windows desktop (including OneDrive Desktop redirection, where applicable). Double-clicking it checks ports 18110 and 18109, starts the API v3 backend and Electron AI bridge if not running, and opens your normal browser. It leaves the original 18108 service untouched.

**First use:** stop the older manually started 18110 PowerShell backend before double-clicking. The launcher generates a fresh random API token, protects it with Windows DPAPI under `%LOCALAPPDATA%\WeFlow\AI-Launcher\api-token.dpapi`, and reuses it across restarts. If 18110 is already occupied by another program, or by a backend that was started by hand with a different token, the launcher says so and stops: it never sends its token to a server it did not start. Stop that server and double-click again.

This installer does **not** turn 18110 into a Windows startup service. It simply starts components when you double-click. Delete **WeFlow AI.lnk** from the desktop to remove the shortcut.
