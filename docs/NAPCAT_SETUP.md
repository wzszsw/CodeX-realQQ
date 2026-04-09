# NapCatQQ Setup

This document describes the setup path for running `CodeX-realQQ` with:

- official QQ NT
- NapCatQQ
- OneBot 11 WebSocket
- local Codex CLI

It assumes a Windows machine and a real QQ account.

## 1. Prepare QQ NT

Requirements:

- official QQ NT is installed
- the target QQ account can log in normally
- the same Windows user session will also run `CodeX-realQQ`

This project does not use Tencent official bot credentials. `appid` and `appsecret` are irrelevant for this runtime path.

## 2. Install and Start NapCatQQ

Recommended upstream project:

- <https://github.com/NapNeko/NapCatQQ>

Typical local usage:

1. close QQ NT if needed
2. start NapCatQQ using the local launcher
3. let NapCatQQ attach to QQ NT
4. log in the real QQ account

Confirm that NapCatQQ is loaded successfully before moving on.

## 3. Enable OneBot 11 WebSocket

In NapCatQQ WebUI, enable the local OneBot 11 WebSocket server.

Typical local endpoint:

```text
ws://127.0.0.1:3001
```

Record these values:

- host
- port
- token

If a token is enabled in NapCatQQ, the same token must be configured in `CodeX-realQQ`.

## 4. Prepare `.env`

Copy the NapCat-oriented template:

```powershell
Copy-Item .env.napcat.example .env
```

Recommended starting point:

```env
APP_MODE=onebot

CODEX_BIN=C:\Users\l1622\.version-fox\cache\nodejs\current\node.exe

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

Key notes:

- `KNOWLEDGE_ROOT` can be a parent directory containing multiple projects.
- `KNOWLEDGE_LABEL` is what users will see in answers instead of your local filesystem path.
- `KNOWLEDGE_PROJECTS` can be used to tell the bridge which projects inside that root are the main knowledge sources.
- `ONEBOT_SELF_ID` can be left empty at first. The bridge will try `get_login_info`.
- `ATTACHMENT_DIR` is required for image questions.
- `MAX_IMAGE_ATTACHMENTS` controls how many images from one message are forwarded to Codex.

## 5. Install Dependencies

```powershell
cd D:\develop\SOURCE_CODE\easy-query\CodeX-realQQ
npm install
```

## 6. Start the Bridge

Foreground start:

```powershell
cd D:\develop\SOURCE_CODE\easy-query\CodeX-realQQ
node src/index.js
```

Optional helper script:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-onebot.ps1
```

Expected logs:

```text
CodeX-realQQ starting
mode: onebot
knowledge label: easy-query
knowledge projects: easy-query, easy-query-doc, easy-query-plugin, intellij-community
read-only qa: true
onebot connected: ws://127.0.0.1:3001
onebot self id: 3772046889
```

## 7. Recommended Test Order

1. test private chat first
2. send a simple text question
3. send an image-only message
4. send image + text
5. test a group chat by `@` mentioning the bot account

Good test prompts:

- `你是谁`
- `easy-query 的核心模块有哪些`
- `这是什么`

## 8. Group Behavior

Current group behavior:

- only messages that `@` the logged-in QQ account are processed
- if `QQ_TARGET_GROUPS` is non-empty, only listed groups are allowed

This is intentional to reduce noisy triggers in active groups.

## 9. Image Behavior

Current image support:

- private image-only messages
- private image + text messages
- group image + `@` mention + optional text

Processing details:

- images are stored temporarily under `ATTACHMENT_DIR`
- the bridge then forwards them to Codex using `codex exec -i`
- if the OneBot event does not provide a usable URL directly, the bridge may resolve the image through NapCat APIs

## 10. Common Setup Failures

### WebSocket does not connect

Check:

- NapCatQQ is running
- OneBot WebSocket server is enabled
- `ONEBOT_WS_URL` is correct
- `ONEBOT_ACCESS_TOKEN` matches NapCatQQ

### Bot connects but never replies

Check:

- QQ NT is still logged in
- the account receiving the message is the same one NapCatQQ is attached to
- group messages really `@` the account
- Codex CLI works in the same Windows session

### Text works but images do not

Check:

- `ATTACHMENT_DIR` exists or can be created
- the bridge logs show image download activity
- your local Codex CLI supports `codex exec -i`
