# WeFlow Personal AI bridge (Windows / personal use only)

This optional desktop sidecar connects WeFlow's **local WebUI** to the official OpenAI [Sign in with ChatGPT DevKit](https://github.com/openai/sign-in-with-chatgpt-devkit). It is not the metered OpenAI API; no API key is configured. Eligibility, subscription quotas and credit settings are enforced by OpenAI, not by this application.

**Status: development preview. Not yet verified on a real Windows account. Do not merge into the stable branch until tested.** The stable WeFlow 6.0.0 binary remains unchanged.

## Prerequisites
- Windows 10/11, Node.js >=22.12, Git, npm and an eligible ChatGPT plan
- The existing stable WeFlow Rust server may remain running at `http://127.0.0.1:18108/ui/`.
- Bun >=1.4.3 to build the **modified development WebUI**, which is served separately on `127.0.0.1:18110`.
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

## Build and open a separate WeFlow preview WebUI

The installed WeFlow 6.0.0 WebUI will **not** show the new AI card until you build this branch's WebUI. Keep the existing WeFlow process running at `18108`; start the development preview separately on `18110`.

**Backend compatibility:** WeFlow v6.0.0's CLI has API v2. This development branch's WebUI requires API v3, so you **must not** use the v6.0.0 executable for port 18110. Use a newly compiled CLI from this branch or the matching Windows executable from the `personal-weflow-api-v3-windows-x64` GitHub Actions artifact once its build succeeds. Keep the stable v6.0.0 executable untouched.

From the repository root:

```powershell
cd web
bun install --frozen-lockfile
bun run check
$previewDir = (Resolve-Path .\dist).Path
# The preinstalled v6.0.0 executable only supports API v2; the AI WebUI requires API v3.
# Build the newer CLI from this branch, or download the Windows API v3 binary from
# the green "Personal WeFlow AI preview checks" workflow artifact.
cd ..
cargo build --release -p weflow-cli --target x86_64-pc-windows-msvc
$exe = (Resolve-Path ".\target\x86_64-pc-windows-msvc\release\weflow.exe").Path
& $exe serve --host 127.0.0.1 --port 18110 --ui-dir $previewDir
```

Open the full token-bearing URL emitted by that **preview service** (port 18110) in Edge/Chrome. Do not close the terminal while using it. If the installed binary's `--ui-dir` option differs, verify it with `& $exe serve --help` rather than guessing.

## Use
1. Open the local Electron bridge window. Click **使用 ChatGPT 登录**, approve the requested account and token-sharing permissions in the official browser.
2. Return to the bridge window and click **复制本地桥接令牌**.
3. In the **preview** WeFlow WebUI at port **18110**, open a real conversation, open **AI 助手** and paste the bridge token.
4. Click **连接本地 AI 桥接** and choose a model from the models returned for your account.
5. Pick a period, ask a question, and explicitly check the confirmation before sending any selected chat excerpt.

The bridge listens only on `127.0.0.1:18109`; it accepts requests only from the local WeFlow origins on ports `18108` and `18110`, with a per-process secret. Keep the Electron window running; a restart changes the bridge token, which must be copied again.

**Privacy:** WeFlow's database stays on the Windows computer, but the *selected text* is sent to OpenAI **only when you click Analyze**. The window encrypts sign-in credentials with Electron's Windows OS-protected safeStorage; it does not expose them to the browser. Never commit your private conversations, API keys, WeFlow tokens or authorization credentials. The AI can be wrong: verify quoted message references.

## Limitations
- Only **the newest 200 messages of the selected conversation** are considered, then at most 80 text messages / 12,000 characters are transmitted. This is not a complete chat-history search or RAG index.
- The model must cite `[localId@timestamp]`; check citations against WeFlow. Source jumping and semantic search are not implemented.
- The browser does not persist bridge access tokens. A bridge restart requires reconnecting.
- AI requests are one at a time, with a 120s timeout. Bridge currently does not stream partial results.
- All AI calls are restricted by the ChatGPT plan's actual eligibility/usage quotas. **The bridge does not implement independent billing controls**; to guarantee no paid overage, keep paid credits disabled in the account settings.
- The bridge currently runs as a separate desktop window; it is not bundled into WeFlow's releases.
