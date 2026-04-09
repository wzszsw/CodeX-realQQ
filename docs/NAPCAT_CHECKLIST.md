# NapCatQQ Checklist

This checklist is for verifying the real-QQ runtime path of `CodeX-realQQ`.

## Before You Start

Confirm all of the following:

1. official QQ NT is installed
2. the target real QQ account can log in
3. NapCatQQ is installed and compatible with the current QQ NT version
4. local Codex CLI works in the same Windows user session
5. Node.js is installed

## NapCatQQ Side

Confirm:

- QQ NT is open
- the target QQ account is logged in
- NapCatQQ is successfully attached
- NapCatQQ WebUI is reachable
- OneBot 11 WebSocket server is enabled

Record:

- `ONEBOT_WS_URL`
- `ONEBOT_ACCESS_TOKEN`
- the logged-in QQ account id

## `CodeX-realQQ` Side

Create `.env`:

```powershell
Copy-Item .env.napcat.example .env
```

Verify at least these fields:

```env
APP_MODE=onebot
CODEX_BIN=...
KNOWLEDGE_ROOT=D:\develop\SOURCE_CODE\easy-query
KNOWLEDGE_LABEL=easy-query
KNOWLEDGE_PROJECTS=easy-query,easy-query-doc,easy-query-plugin,intellij-community
READ_ONLY_QA_MODE=true
ATTACHMENT_DIR=./data/attachments
MAX_IMAGE_ATTACHMENTS=3
ONEBOT_WS_URL=ws://127.0.0.1:3001
ONEBOT_ACCESS_TOKEN=...
ONEBOT_REPLY_MODE=send_msg
QQ_TARGET_GROUPS=
```

Checklist:

- `KNOWLEDGE_ROOT` points to the directory you want Codex to read
- `KNOWLEDGE_LABEL` does not expose sensitive local naming
- `KNOWLEDGE_PROJECTS` matches the main projects that live under that knowledge root
- `CODEX_BIN` is valid in the bridge process environment
- `ATTACHMENT_DIR` is writable
- `QQ_TARGET_GROUPS` is empty or intentionally configured

## Start Command

```powershell
cd D:\develop\SOURCE_CODE\easy-query\CodeX-realQQ
node src/index.js
```

Expected log lines:

```text
CodeX-realQQ starting
mode: onebot
onebot connected: ws://127.0.0.1:3001
onebot self id: ...
```

## First-Round Functional Tests

### 1. Private text

Send:

- `你是谁`
- `easy-query 的核心模块有哪些`

Expected:

- bot returns a text answer

### 2. Private image-only

Send:

- one image without text

Expected:

- bot enters `处理中...`
- bot returns an image-aware answer

### 3. Private image + text

Send:

- an image with `这是什么`

Expected:

- bridge handles both the image and text

### 4. Group mention

Send in a group:

- `@bot easy-query 的查询入口在哪`

Expected:

- only `@bot` messages trigger a reply

## If Something Fails, Capture These Items

- `CodeX-realQQ` console output
- NapCatQQ console or WebUI logs
- actual `ONEBOT_WS_URL`
- whether private chat works
- whether group mention works
- whether image download succeeded

Useful image log example:

```text
attachments received: total=1, images=1, downloaded=1
```

## Typical Failure Mapping

### No WebSocket connection

Usually means:

- NapCatQQ is not running
- OneBot WebSocket is not enabled
- URL or token mismatch

### Connected but no messages processed

Usually means:

- wrong QQ account is logged in
- group message did not `@` the bot
- `QQ_TARGET_GROUPS` filtered the group

### Text works, image fails

Usually means:

- OneBot image segment was not resolved
- `ATTACHMENT_DIR` is not writable
- Codex CLI image input support is missing

### Bot reply leaks local details

Usually means:

- `KNOWLEDGE_ROOT` is too broad
- `KNOWLEDGE_LABEL` is not sanitized enough
- outbound sanitization rules need tightening
