# CodeX-realQQ

`CodeX-realQQ` is a local real-QQ knowledge-base Q&A bridge built on top of:

- official QQ NT
- NapCatQQ
- OneBot 11 WebSocket
- local Codex CLI, Gemini CLI, or Claude Code CLI
- a read-only knowledge-base Q&A layer

It is intended for scenarios such as:

- answering questions in private chat or group chat
- reading one or more local directories as the knowledge base
- explaining implementation details, module structure, call chains, and configuration behavior
- analyzing images that users send together with a question

The current implementation is generic. It does not need to be bound to a single project. You can point it at a directory that contains multiple projects, such as both `easy-query` and `hibernate`.

## What It Does

Incoming QQ messages are forwarded to the configured local CLI provider, which reads from a configured local knowledge-base directory and returns a textual answer. Replies are sent back to QQ through NapCatQQ.

Supported message patterns:

- private chat text
- private chat image + text
- private chat image only
- group messages that `@` the logged-in QQ account

Built-in commands:

- `/help`
- `/status`
- `/reset`

## What It Does Not Do

- It is not the official Tencent QQ bot platform.
- It does not require QQ bot `appid` / `appsecret`.
- It is not a hosted service.
- It is not a write-enabled coding agent by default.

The intended mode is read-only knowledge-base Q&A.

## Architecture

Runtime flow:

1. A real QQ account logs in through official QQ NT.
2. NapCatQQ injects into QQ NT and exposes a local OneBot 11 WebSocket server.
3. `CodeX-realQQ` connects to that WebSocket server as a client.
4. Incoming messages are normalized into the bridge's internal message model.
5. Text and image attachments are passed to the configured local CLI provider.
6. The selected provider reads the configured knowledge base and generates an answer.
7. The answer is sanitized and sent back through NapCatQQ.

Main code locations:

- [src/index.js](./src/index.js)
- [src/transport/onebot-transport.js](./src/transport/onebot-transport.js)
- [src/engine/message-engine.js](./src/engine/message-engine.js)
- [src/provider/index.js](./src/provider/index.js)
- [src/provider/codex-runner.js](./src/provider/codex-runner.js)
- [src/provider/gemini-runner.js](./src/provider/gemini-runner.js)
- [src/provider/claude-runner.js](./src/provider/claude-runner.js)
- [src/session/file-session-store.js](./src/session/file-session-store.js)

### How to set the knowledge-base path

Set it in `.env`:

```env
KNOWLEDGE_ROOT=D:\develop\SOURCE_CODE\easy-query
KNOWLEDGE_LABEL=easy-query
KNOWLEDGE_PROJECTS=easy-query,easy-query-doc,easy-query-plugin,intellij-community
```

Meaning:

- `KNOWLEDGE_ROOT`: the local directory that Codex can read as the knowledge base
- `KNOWLEDGE_LABEL`: the external name shown to users instead of the real local path
- `KNOWLEDGE_PROJECTS`: the main project names inside the knowledge base, used to guide answer scope and priority

You can point `KNOWLEDGE_ROOT` to:

- a single project directory
- a parent directory that contains multiple projects
- a mixed knowledge base containing code, docs, notes, and examples

## Requirements

- Windows
- official QQ NT installed and able to log in
- NapCatQQ installed on the same machine
- OneBot 11 WebSocket enabled in NapCatQQ
- Node.js 20+
- a working local Codex CLI

## Quick Start

### Windows guided setup

There is now a Windows guided setup script:

```powershell
cd D:\develop\SOURCE_CODE\easy-query\CodeX-realQQ
.\scripts\setup-windows.cmd
```

What it does:

- checks Node.js
- checks whether `node_modules` exists
- optionally runs `npm install`
- checks default QQ NT paths
- checks default NapCatQQ paths
- creates `.env` from `.env.napcat.example` if needed
- checks OneBot WebSocket settings
- optionally launches NapCatQQ
- prints the remaining manual steps

What it does not fully automate:

- QQ NT installation
- NapCatQQ installation
- QR-code login
- NapCatQQ WebUI configuration

Those parts still require manual confirmation because they are GUI- and account-driven.

### 1. Install dependencies

```powershell
cd D:\develop\SOURCE_CODE\easy-query\CodeX-realQQ
npm install
```

### 2. Create `.env`

```powershell
Copy-Item .env.napcat.example .env
```

Example:

```env
APP_MODE=onebot
LLM_PROVIDER=claude

CODEX_BIN=C:\Users\l1622\.version-fox\cache\nodejs\current\node.exe
GEMINI_BIN=gemini
GEMINI_MODEL=

KNOWLEDGE_ROOT=D:\develop\SOURCE_CODE\easy-query
KNOWLEDGE_LABEL=easy-query
KNOWLEDGE_PROJECTS=easy-query,easy-query-doc,easy-query-plugin,intellij-community
READ_ONLY_QA_MODE=true
SESSION_STORE_FILE=./data/sessions.json
ATTACHMENT_DIR=./data/attachments
MAX_REPLY_CHARS=1500
MAX_HISTORY_MESSAGES=20
SHOW_REASONING=false
MAX_IMAGE_ATTACHMENTS=3

ONEBOT_WS_URL=ws://127.0.0.1:3001
ONEBOT_ACCESS_TOKEN=your_token
ONEBOT_SELF_ID=
ONEBOT_REPLY_MODE=send_msg

QQ_TARGET_GROUPS=
QQ_ACCOUNT_UIN=
QQ_CLIENT_MODE=napcatqq
QQ_POLL_INTERVAL_MS=1500
```

Notes:

- `KNOWLEDGE_ROOT` can be a parent directory containing multiple projects.
- `KNOWLEDGE_LABEL` is the public-facing name used in replies instead of the local path.
- `KNOWLEDGE_PROJECTS` is a comma-separated list of the main projects inside the knowledge base, useful for setups like `easy-query`, `easy-query-doc`, `easy-query-plugin`, and `intellij-community`.
- If `easy-query-doc` exists under `KNOWLEDGE_ROOT`, answers based on the docs should include the matching public chapter URL, for example `https://www.easy-query.com/easy-query-doc/func/datetime.html`.
- When the question is about core `easy-query` behavior, the bridge will prioritize the main project and only pull in plugin or IntelliJ Platform sources when the question is clearly about IDEA integration or platform internals.
- `LLM_PROVIDER`: selects the CLI provider, currently `claude`, `codex`, or `gemini`; the default is `claude`
- `CLAUDE_BIN`: executable entry when `LLM_PROVIDER=claude`
- `CODEX_BIN`: executable entry when `LLM_PROVIDER=codex`
- `GEMINI_BIN`: executable entry when `LLM_PROVIDER=gemini`
- `GEMINI_MODEL`: optional Gemini CLI `--model` value
- `ONEBOT_SELF_ID` may be left empty. The bridge will try to detect it through `get_login_info`.
- Leave `QQ_TARGET_GROUPS` empty to allow all groups during early testing.

### 3. Start QQ NT and NapCatQQ

You need a real QQ account logged in through QQ NT, with NapCatQQ already attached.

Typical NapCatQQ checks:

- QQ NT is open and logged in
- NapCatQQ WebUI is reachable
- OneBot WebSocket server is enabled
- WebSocket URL and token match your `.env`

### 4. Start the bridge

```powershell
cd D:\develop\SOURCE_CODE\easy-query\CodeX-realQQ
node src/index.js
```

Expected startup logs:

```text
CodeX-realQQ starting
mode: onebot
provider: codex
provider label: Codex
knowledge label: easy-query
knowledge projects: easy-query, easy-query-doc, easy-query-plugin, intellij-community
read-only qa: true
onebot connected: ws://127.0.0.1:3001
onebot self id: 3772046889
```

## How to Use

### Private Chat

Send a normal QQ private message to the logged-in account, for example:

- `你是谁`
- `easy-query 的分页能力在哪里实现`
- `hibernate 的 session 生命周期是什么`

### Group Chat

Group messages are processed only when they explicitly `@` the logged-in QQ account.

Examples:

- `@bot easy-query 的查询入口在哪`
- `@bot 看一下这张图是什么意思`

### Image Questions

Image understanding is supported in the current bridge.

Supported forms:

- image only
- image + text
- multiple images, up to `MAX_IMAGE_ATTACHMENTS`

Image flow:

1. NapCatQQ reports image segments through OneBot.
2. The bridge materializes the images into `ATTACHMENT_DIR`.
3. Local image paths are attached through the current provider when supported; `codex` uses `-i`, `gemini` uses `@path` file references plus `--include-directories` for temporary attachment directories, and `claude` is given local image paths through the prompt plus `--add-dir` access.

## Privacy and Safety

The current default mode is read-only Q&A.

The bridge is configured to reduce accidental local leakage:

- prompts tell Codex not to reveal local filesystem paths, usernames, hostnames, tokens, or environment details
- outgoing replies are sanitized to mask obvious absolute paths
- knowledge-base references are rewritten to `KNOWLEDGE_LABEL`

Practical caveats:

- This is still a local automation setup, not a hardened security product.
- Do not run it against directories that contain secrets you would never want referenced.
- Do not use a highly sensitive personal QQ account for unattended operation.
- Review generated replies if you plan to expose it in public groups.

## Important Configuration

### Repository and identity

- `KNOWLEDGE_ROOT`: local directory that Codex is allowed to read
- `KNOWLEDGE_LABEL`: public label exposed in answers
- `KNOWLEDGE_PROJECTS`: comma-separated list of the main projects inside the knowledge base
- `READ_ONLY_QA_MODE`: keep this as `true` for knowledge-base Q&A

### OneBot

- `ONEBOT_WS_URL`: NapCatQQ local WebSocket URL
- `ONEBOT_ACCESS_TOKEN`: NapCatQQ token
- `ONEBOT_SELF_ID`: optional; auto-detected if empty
- `ONEBOT_REPLY_MODE`: `send_msg` is the current recommended mode

### Images

- `ATTACHMENT_DIR`: local temporary storage for incoming images
- `MAX_IMAGE_ATTACHMENTS`: max number of images forwarded to Codex for one message

### Scope control

- `QQ_TARGET_GROUPS`: optional allowlist of target group ids

## Operational Notes

- The bridge is not hot-reloaded. Restart `node src/index.js` after code changes.
- Session history is stored locally and reused across messages until `/reset`.
- If you point `KNOWLEDGE_ROOT` at a large parent directory, answers may become slower and less focused.

## Troubleshooting

### OneBot connects, but private or group messages do not trigger replies

Check:

- the account is actually logged in through QQ NT
- NapCatQQ is still attached to the correct QQ NT version
- group messages really `@` the bot account
- `QQ_TARGET_GROUPS` is not filtering the group out

### The bot says `spawn codex ENOENT`

The bridge process cannot resolve the Codex executable.

Fix:

- set `CODEX_BIN=codex` if that works in your terminal
- or point `CODEX_BIN` to the actual executable path
- or point it to `node.exe` if your environment needs to invoke `@openai/codex/bin/codex.js` through Node

### The bot replies with `Codex execution failed`

Check:

- Codex CLI works in the same Windows user session
- the current account still has access to the knowledge base
- your Codex authentication is valid

### Text works, but image questions fail

Check:

- NapCatQQ is reporting image segments
- `ATTACHMENT_DIR` is writable
- the bridge log shows a line like `attachments received: total=1, images=1, downloaded=1`
- your local Codex CLI version supports `codex exec -i`

### The reply still leaks too much local detail

Reduce risk by:

- narrowing `KNOWLEDGE_ROOT`
- using a safer `KNOWLEDGE_LABEL`
- reviewing and tightening sanitization rules in [src/engine/message-engine.js](./src/engine/message-engine.js)

## Files and Directories

- `.env`
- `.env.example`
- `.env.napcat.example`
- `data/sessions.json`
- `data/attachments/`
- `logs/stdout.log`
- `logs/stderr.log`

## Related Docs

- [README_CN.md](./README_CN.md)
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- [docs/NAPCAT_SETUP.md](./docs/NAPCAT_SETUP.md)
- [docs/NAPCAT_CHECKLIST.md](./docs/NAPCAT_CHECKLIST.md)
