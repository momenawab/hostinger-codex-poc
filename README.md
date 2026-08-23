# Hostinger + Codex CLI - Proof of Concept

Proves (or disproves) this chain:

```
Browser -> Hostinger Node.js Web App -> child_process -> Codex CLI -> auth -> response
```

This is a **compatibility probe only**. It is not production software and is not
wired into any other project.

---

## Files

| Path | Purpose |
|---|---|
| `server.js` | Express app. Token-gated routes, rate limiting, error handling. |
| `src/codex.js` | Codex runner: binary resolution, sandboxing, timeouts, concurrency gate, redaction. |
| `public/index.html` | Chat UI + live auth status. No build step, no external assets. |
| `scripts/inspect-env.js` | **Step 1** - environment report. Run this on Hostinger first. |
| `scripts/probe-child.js` | **Step 2** - child-process capability probe. |
| `scripts/codex-check.js` | **Steps 3-5** - CLI availability, auth, and one live prompt. |
| `.env.example` | Config template. Contains no secrets. |

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/` | Chat UI |
| `GET` | `/api/codex/status` | Real `codex login status` check |
| `POST` | `/api/chat` | `{ "message": "..." }` |
| `POST` | `/test-codex` | `{ "prompt": "..." }` |
| `POST` | `/api/codex/login/start` | Begin browser ChatGPT sign-in; returns URL + device code |
| `GET` | `/api/codex/login/status` | Poll until the user approves |
| `POST` | `/api/codex/login/cancel` | Abort an in-flight sign-in |
| `GET` | `/api/diagnose` | Why won't Codex execute? Paths + permission bits only |
| `GET` | `/api/env` | Env report; variable **names only** |
| `GET` | `/healthz` | Liveness, unauthenticated |

All routes except `/`, `/healthz` and `/api/meta` require the `POC_TOKEN`, sent as
`x-poc-token:` (or `Authorization: Bearer`). The endpoint spends real model quota,
so it is never left open.

---

## Run locally

```bash
npm install
export POC_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
node scripts/inspect-env.js     # Step 1
node scripts/probe-child.js     # Step 2
node scripts/codex-check.js     # Steps 3-5
npm start                       # then open http://localhost:3000
```

If `POC_TOKEN` is unset, a random one is generated and printed to the log at boot.

---

## Deploy to Hostinger

1. **Upload** this folder (excluding `node_modules/`) to something like
   `/home/<user>/codex-poc`. Do not place it inside an existing site directory.
2. **hPanel -> Website -> Node.js App** (or "Setup Node.js App"):
   - Application root: `codex-poc`
   - Startup file: `server.js`
   - Node version: 18 or newer
3. **Install dependencies** via the panel's *Run NPM Install*, or over SSH:
   ```bash
   cd ~/codex-poc && npm install
   ```
   This downloads a ~205 MB native Codex binary (~258 MB total). Check your disk quota.
4. **Set environment variables** in the panel: `POC_TOKEN` (required), and
   `CODEX_HOME` if `HOME` is unreliable under the process manager.
5. **Authenticate Codex** on the server - see below.
6. **Restart** the app, then open the application URL. The exact URL is shown in
   hPanel; it is either your domain or a subdomain you bound to the Node app.
   The UI is at `/`; paste the `POC_TOKEN` to unlock it.

**Verify on the server before trusting anything:**
```bash
cd ~/codex-poc
node scripts/inspect-env.js     # confirms exec bit, /tmp, spawn, long-running procs
node scripts/codex-check.js     # confirms CLI + auth + a live response
```

---

## Authentication

`src/codex.js` never reads, prints, logs, or stores a credential. It detects state
by shelling out to the official `codex login status` and forwards auth env vars
verbatim without inspecting them.

Codex CLI 0.148.0 supports these (from `codex login --help`):

| Mechanism | Headless? | Command |
|---|---|---|
| ChatGPT subscription, device flow | **Yes** | `codex login --device-auth` |
| API key via stdin | Yes | `printenv OPENAI_API_KEY \| codex login --with-api-key` |
| Access token via stdin | Yes | `printenv CODEX_ACCESS_TOKEN \| codex login --with-access-token` |
| `OPENAI_API_KEY` env var | Yes | set it in hPanel |
| ChatGPT browser OAuth | **No** - needs a local browser + loopback callback | `codex login` |

### Sign in from the browser (no SSH needed)

The UI has a **Sign in with ChatGPT** button, which appears whenever the CLI is
installed but has no credentials. It drives the same official device-code flow:

1. Click it. The server runs `codex login --device-auth`.
2. The page shows a URL and a one-time code (valid 15 minutes).
3. Open that URL on any device, sign in with your own ChatGPT account, enter the code.
4. The page polls and flips to **Codex: Authenticated** on its own.

Only a public URL and a short-lived device code ever reach the browser. The
credential is written by the Codex CLI into `$CODEX_HOME` and is never read,
logged, or returned by this app. You are never asked for your password.

> **Anti-phishing:** only enter a code you started from your own admin page. A code
> someone sends you would link *your* ChatGPT account to *their* server. The UI
> repeats this warning inline.

### Same flow over SSH, if you prefer

```bash
cd ~/codex-poc
./node_modules/.bin/codex login --device-auth
```

It prints a URL and a short code. You open that URL **on your own laptop/phone**,
sign in with your own account, and approve the code. Credentials are written to
`$CODEX_HOME/auth.json` on the server. Then confirm:

```bash
./node_modules/.bin/codex login status     # expect: Logged in using ChatGPT
```

You are never asked for your password by this project, and no token is printed,
logged, committed, or sent to the browser.

**If you have no SSH access**, you cannot complete any server-side login, and the
only workable route is setting `OPENAI_API_KEY` in hPanel.

### Terms-of-use caveat (please read)

Subscription (ChatGPT-plan) auth is intended for the *individual subscriber's own
use*. Using it to power a web endpoint that other people can send prompts to looks
like account sharing and may breach OpenAI's terms. For anything multi-user or
production, the sanctioned path is an **API key**, which is metered and billed for
programmatic use. This POC keeps the endpoint token-gated partly for that reason.
Confirm your intended usage against OpenAI's current terms before going further -
that judgement is yours to make, not something this code can settle.

---

## Safety model

- `spawn()` with an **argument array**, `shell: false` - shell injection is impossible.
- The prompt travels over **stdin**, so it never appears in `ps` or hits `ARG_MAX`.
- Codex runs in an **empty scratch directory**, never in a real project.
- **Shell/exec tools are disabled by default** (`--disable shell_tool unified_exec
  browser_use computer_use plugins hooks`).
- `-s read-only`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`.
- Hard timeout with `SIGTERM` -> `SIGKILL`, killed by **process group** so no orphans.
- Concurrency gate (default 2) with a bounded queue; excess returns `BUSY`.
- Output capped at 256 KB; prompts capped at 4000 chars; JSON body capped at 64 KB.
- Token-shaped strings are redacted from anything returned to the browser.
- The UI renders responses with `textContent`, never `innerHTML`.

### Verified caveat about `-s read-only`

Read-only mode blocks **writes only**. A read-only Codex with a shell tool can
still `cat` any file the Unix user can read - which on shared hosting means every
other site owned by that user. This was tested and confirmed. Disabling the shell
tool is what actually contains it, which is why that is the default here. Setting
`CODEX_ALLOW_SHELL=1` gives up that guarantee.

---

## Troubleshooting

### `Codex binary could not be executed (EACCES)`

The binary installed but will not run. Hit **Diagnose** in the UI (or run
`node scripts/diagnose-exec.js`) - it distinguishes the four causes:

| Conclusion | Meaning | Fix |
|---|---|---|
| `WORKING` | Exec bit was missing; it has been repaired | Restart the app |
| `BINARY_NOT_INSTALLED` | Platform package absent | `npm install --include=optional @openai/codex` |
| `WRONG_ARCHITECTURE` | Binary built for another OS/CPU | Delete `node_modules`, reinstall **on the server** |
| `NOEXEC_APP_DIR` | App dir mounted `noexec` | Copy the binary somewhere executable, set `CODEX_BIN` |
| `NOEXEC_EVERYWHERE` | Account may not execute binaries at all | Codex CLI cannot work here; use the OpenAI HTTP API |

The app now prefers running the launcher through `node` rather than relying on
the shim's executable bit, and re-applies `chmod +x` to the native binary at
startup - which resolves the common case automatically.

### `noexec` workaround

If only the app directory is `noexec`, copy the binary somewhere that is not:

```bash
mkdir -p ~/bin
cp node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex ~/bin/codex
chmod +x ~/bin/codex
~/bin/codex --version          # confirm before relying on it
```

Then set `CODEX_BIN=/home/<user>/bin/codex` in hPanel and restart.

## Known limitations

- **Latency.** 11-35 s per prompt. Two concurrent requests roughly double it.
- **Disk.** ~258 MB of `node_modules`, mostly one 205 MB binary.
- **Memory.** A Rust binary per request, on top of Node.
- **Outbound HTTPS** to OpenAI must be permitted by Hostinger's firewall.
- **Proxy timeouts.** Hostinger's front-end proxy may cut requests before Codex
  finishes. Keep `CODEX_TIMEOUT_MS` under that ceiling.
- **Process caps.** Shared hosting limits concurrent processes; each request adds one.
- **No SSH = no subscription login.**
