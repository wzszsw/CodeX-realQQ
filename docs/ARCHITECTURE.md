# Architecture

This document describes the current runtime architecture of `CodeX-realQQ`.

## Goal

The project connects a real QQ account to a local Codex CLI process so users can ask knowledge-base questions in QQ private chats or group chats.

The design target is:

- local-only deployment
- real QQ account instead of official QQ bot platform
- OneBot-compatible transport boundary
- read-only knowledge-base Q&A
- optional image-assisted questions

## Runtime Flow

1. Official QQ NT logs in a real QQ account.
2. NapCatQQ injects into QQ NT.
3. NapCatQQ exposes a local OneBot 11 WebSocket server.
4. `CodeX-realQQ` connects to that WebSocket server as a client.
5. Incoming OneBot events are mapped into an internal message model.
6. The message engine handles commands, session history, image materialization, and prompt preparation.
7. The provider starts the configured local CLI provider process.
8. The selected provider reads from the configured knowledge base and returns a final answer.
9. The answer is sanitized and sent back to QQ through NapCatQQ.

## Normalized Message Model

Every transport is expected to convert platform-specific payloads into a normalized inbound message:

- `transport`
- `conversationId`
- `senderId`
- `chatType`
- `messageId`
- `text`
- `attachments`
- `transportRef`
- `mentioned`
- `timestampMs`

Current attachment usage:

- `image`

This allows the engine to remain transport-agnostic while still supporting transport-assisted file resolution when needed.

## Layers

### `transport`

Responsible for:

- receiving inbound messages from the platform
- mapping platform payloads into normalized messages
- sending plain-text replies
- resolving platform-specific attachment files when necessary

Current implementation:

- [src/transport/onebot-transport.js](../src/transport/onebot-transport.js)

Current transport choice:

- OneBot 11 over local WebSocket

Current adapter:

- NapCatQQ: <https://github.com/NapNeko/NapCatQQ>

Why this boundary was chosen:

- it avoids hard-coding against one specific QQ NT patch surface
- it keeps the bridge generic enough to work with other OneBot-capable adapters later
- it provides a stable message abstraction for both private and group chat

### `engine`

Responsible for:

- command handling
- prompt construction
- session lookup and update
- message sanitization
- attachment download and staging
- reply chunking

Current implementation:

- [src/engine/message-engine.js](../src/engine/message-engine.js)

Current command set:

- `/help`
- `/status`
- `/reset`

### `provider`

Responsible for:

- launching the selected CLI provider
- passing prompt text and attached images when supported
- parsing provider output into a normalized result
- returning final answer text, reasoning, logs, and status

Current implementation:

- [src/provider/index.js](../src/provider/index.js)
- [src/provider/codex-runner.js](../src/provider/codex-runner.js)
- [src/provider/gemini-runner.js](../src/provider/gemini-runner.js)

Current provider contract:

- input: config, session, user text, image paths
- output: `ok`, `error`, `text`, `reasonings`, `logs`, `threadId`

Current provider choices:

- `codex`: full current path, including direct image forwarding through `codex exec -i`
- `gemini`: prompt-based CLI adapter through `gemini --prompt --output-format json`; local images are referenced in the prompt with `@path`, and attachment directories outside `KNOWLEDGE_ROOT` are passed through `--include-directories`
- if the configured primary provider fails, the dispatcher automatically tries the other provider before returning an error

### `session`

Responsible for:

- durable conversation history
- per-conversation continuity
- local persistence between process restarts

Current implementation:

- [src/session/file-session-store.js](../src/session/file-session-store.js)

## Message Routing Rules

### Private Chat

- all private messages are accepted

### Group Chat

- only messages that explicitly `@` the logged-in QQ account are processed
- if `QQ_TARGET_GROUPS` is configured, only listed group ids are accepted

This keeps unsolicited group noise out of the prompt path.

## Image Handling

Image support is part of the current architecture.

Current flow:

1. NapCatQQ reports OneBot image segments.
2. The transport extracts image attachment metadata.
3. The engine downloads or resolves image files into `ATTACHMENT_DIR`.
4. The provider passes those file paths to `codex exec -i`.

Fallback path:

- if a OneBot image segment does not provide a usable URL, the transport may resolve it through NapCat APIs such as `get_image` or `get_file`

## Privacy Boundary

This project is not a hardened security system. It is a local automation bridge with best-effort output masking.

Current mitigation layers:

- prompt-level instruction not to reveal local paths, usernames, hostnames, tokens, or environment details
- output sanitization for obvious absolute paths
- replacement of real knowledge-base paths with `KNOWLEDGE_LABEL`

This reduces accidental leakage but does not provide a formal guarantee.

## Why the Project Is Directory-Oriented

The bridge points at `KNOWLEDGE_ROOT`, not a single project.

This is intentional because common use cases include:

- answering across multiple related projects
- comparing two projects in one conversation
- dropping several source trees under one parent directory

Examples:

- `D:\develop\SOURCE_CODE\easy-query`
- `D:\develop\SOURCE_CODE\knowledge-root`

## Non-Goals

The current architecture does not aim to support:

- official Tencent bot API integration
- reverse WebSocket mode
- HTTP webhook push mode
- rich outbound media rendering
- multi-model orchestration
- code-writing automation by default

## Suggested Future Extensions

- stricter outbound sanitization rules
- group-specific persona or knowledge labels
- better image/file lifecycle cleanup
- optional rate limiting and allowlists
- admin commands for runtime status and reload
