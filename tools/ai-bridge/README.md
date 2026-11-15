# WeFlow Personal AI bridge (Windows / personal use only)

This optional desktop sidecar connects WeFlow's **local WebUI** to the official OpenAI [Sign in with ChatGPT DevKit](https://github.com/openai/sign-in-with-chatgpt-devkit). It is not the metered OpenAI API; no API key is configured. Eligibility, subscription quotas and credit settings are enforced by OpenAI, not by this application.

**Status: development preview. Not yet verified on a real Windows account. Do not merge into the stable branch until tested.** The stable WeFlow 6.0.0 binary remains unchanged.

## Prerequisites
- Windows 10/11, Node.js >=22.12, Git, npm and an eligible ChatGPT plan
- WeFlow Rust server with WebUI at `http://127.0.0.1:18108/ui/`
- In your ChatGPT settings, check that **extra paid credits/overage are not enabled**. No payment card or API key is required in this bridge.
- Official open-source DevKit license applies to the downloaded DevKit; do not copy the DevKit sources into this repository.

## Install in a local development clone (PowerShell)

From the root of your personal WeFlow repository, on `feat/llm-local-chat-analysis`:

```powershell
cd tools\ai-bridge
git clone https://github.com/openai/sign-in-with-chatgpt-devkit.git siwc-devkit
cd siwc-devkit
npm ci
npm run build -w @siwc/local
cd ..
npm install
npm test
npm start
```

The cloned DevKit is intentionally git-ignored and remains local. Download only from the official upstream repository. Review source changes before updating it in the future.

## Use
1. Open the local Electron bridge window. Click **使用 ChatGPT 登录**, approve the requested account and token-sharing permissions in the official browser.
2. Return to the bridge window and click **复制本地桥接令牌**.
3. In the existing WeFlow WebUI, open a real conversation, open **AI 助手** and paste the bridge token.
4. Click **连接本地 AI 桥接** and choose a model from the models returned for your account.
5. Pick a period, ask a question, and explicitly check the confirmation before sending any selected chat excerpt.

The bridge listens only on `127.0.0.1:18109`; it accepts requests only from `127.0.0.1:18108` or `localhost:18108`, with a per-process secret. Keep the Electron window running; a restart changes the bridge token, which must be copied again.

**Privacy:** WeFlow's database stays on the Windows computer, but the *selected text* is sent to OpenAI **only when you click Analyze**. The window encrypts sign-in credentials with Electron's Windows OS-protected safeStorage; it does not expose them to the browser. Never commit your private conversations, API keys, WeFlow tokens or authorization credentials. The AI can be wrong: verify quoted message references.

## Limitations
- Only **the newest 200 messages of the selected conversation** are considered, then at most 80 text messages / 12,000 characters are transmitted. This is not a complete chat-history search or RAG index.
- The model must cite `[localId@timestamp]`; check citations against WeFlow. Source jumping and semantic search are not implemented.
- The browser does not persist bridge access tokens. A bridge restart requires reconnecting.
- AI requests are one at a time, with a 120s timeout. Bridge currently does not stream partial results.
- All AI calls are restricted by the ChatGPT plan's actual eligibility/usage quotas. **The bridge does not implement independent billing controls**; to guarantee no paid overage, keep paid credits disabled in the account settings.
- The bridge currently runs as a separate desktop window; it is not bundled into WeFlow's releases.
