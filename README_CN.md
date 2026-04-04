# CodeX-realQQ

`CodeX-realQQ` 是一套运行在本机上的真实 QQ 源码问答桥接系统，核心链路是：

- 官方 QQ NT
- NapCatQQ
- OneBot 11 WebSocket
- 本机 Codex CLI
- 只读源码问答层

它适合做这些事情：

- 在 QQ 私聊或群聊里自动回答源码问题
- 把一个本地目录当成知识根目录进行问答
- 解释代码实现、模块关系、调用链和配置入口
- 结合用户发送的图片一起回答问题

当前实现不是绑定单一仓库，而是绑定一个目录。你可以把 `easy-query`、`hibernate` 等多个源码仓库都放在同一个知识目录下。

## 它是什么

收到 QQ 消息后，系统会把消息转发给本机的 Codex CLI。Codex 在指定的本地源码目录里只读检索和分析，然后把回答通过 NapCatQQ 发回 QQ。

当前支持：

- 私聊文本
- 私聊图片 + 文本
- 私聊纯图片
- 群聊中 `@` 当前登录 QQ 号的消息

内置命令：

- `/help`
- `/status`
- `/reset`

## 它不是什么

- 它不是腾讯官方 QQ 机器人平台
- 它不依赖 QQ 机器人 `appid` / `appsecret`
- 它不是云端托管服务
- 它默认不是可写的自动编码代理

当前推荐用途是只读源码问答。

## 系统架构

运行链路如下：

1. 用真实 QQ 号登录官方 QQ NT
2. NapCatQQ 注入 QQ NT，并暴露本地 OneBot 11 WebSocket
3. `CodeX-realQQ` 作为客户端连接这个 WebSocket
4. 收到的消息被标准化成内部消息模型
5. 文本和图片一起交给本机 Codex CLI
6. Codex 读取配置的知识目录并生成回答
7. 回答经过清洗后再通过 NapCatQQ 发回 QQ

核心代码位置：

- [src/index.js](./src/index.js)
- [src/transport/onebot-transport.js](./src/transport/onebot-transport.js)
- [src/engine/message-engine.js](./src/engine/message-engine.js)
- [src/provider/codex-runner.js](./src/provider/codex-runner.js)
- [src/session/file-session-store.js](./src/session/file-session-store.js)

## 环境要求

- Windows
- 已安装官方 QQ NT，并且能正常登录
- 同机已安装 NapCatQQ
- NapCatQQ 已启用 OneBot 11 WebSocket
- Node.js 20+
- 本机 Codex CLI 可正常使用

## 快速启动

### 1. 安装依赖

```powershell
cd D:\develop\SOURCE_CODE\easy-query\CodeX-realQQ
npm install
```

### 2. 创建 `.env`

```powershell
Copy-Item .env.napcat.example .env
```

参考配置：

```env
APP_MODE=onebot

CODEX_BIN=C:\Users\l1622\.version-fox\cache\nodejs\current\node.exe

KNOWLEDGE_ROOT=D:\develop\SOURCE_CODE\easy-query
KNOWLEDGE_LABEL=easy-query
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

说明：

- `KNOWLEDGE_ROOT` 可以是一个父目录，里面放多个源码仓库。
- `KNOWLEDGE_LABEL` 是对外展示的知识库名字，用来替代本地真实路径。
- `CODEX_BIN` 如果环境里直接能跑 `codex`，可以写成 `codex`。
- 在部分 Windows 环境中，直接写 `node.exe` 会比包装命令更稳定。
- `ONEBOT_SELF_ID` 可以先留空，桥接会自动通过 `get_login_info` 获取。
- 测试阶段可先把 `QQ_TARGET_GROUPS` 留空，不限制群。

### 3. 启动 QQ NT 和 NapCatQQ

你需要先保证：

- QQ NT 已打开并登录真实 QQ 号
- NapCatQQ 已成功注入
- NapCatQQ WebUI 可访问
- OneBot WebSocket Server 已开启
- WebSocket 地址和 token 与 `.env` 一致

### 4. 启动桥接程序

```powershell
cd D:\develop\SOURCE_CODE\easy-query\CodeX-realQQ
node src/index.js
```

正常日志示例：

```text
CodeX-realQQ starting
mode: onebot
knowledge label: easy-query
read-only qa: true
onebot connected: ws://127.0.0.1:3001
onebot self id: 3772046889
```

## 使用方式

### 私聊

直接给当前登录的 QQ 号发消息，例如：

- `你是谁`
- `easy-query 的分页能力在哪里实现`
- `hibernate 的 session 生命周期是什么`

### 群聊

群里只有明确 `@` 当前登录 QQ 号的消息才会被处理。

例如：

- `@bot easy-query 的查询入口在哪`
- `@bot 看一下这张图是什么意思`

### 图片问答

当前版本已经支持图片理解。

支持形式：

- 纯图片
- 图片 + 文字
- 多张图片，最多 `MAX_IMAGE_ATTACHMENTS` 张

图片处理流程：

1. NapCatQQ 通过 OneBot 上报图片消息段
2. 桥接程序把图片落到 `ATTACHMENT_DIR`
3. 再通过 `codex exec -i` 把图片传给本机 Codex CLI

## 隐私与安全

当前默认运行模式是只读问答。

系统已经做了几层降低泄漏风险的处理：

- 在提示词中明确要求 Codex 不暴露本地路径、用户名、主机名、token、环境细节
- 发送回复前会再做一层明显绝对路径清洗
- 对外统一使用 `KNOWLEDGE_LABEL` 指代知识库

但要注意：

- 这只是本地自动化方案，不是严格加固过的安全产品
- 不要把它直接指向包含高敏感数据的目录
- 不建议用高敏感个人主号长期无人值守挂机
- 如果要在公开群使用，建议先人工观察回复质量和泄漏风险

## 关键配置项

### 知识目录和身份

- `KNOWLEDGE_ROOT`：Codex 可读取的本地目录
- `KNOWLEDGE_LABEL`：对外展示的知识库名称
- `READ_ONLY_QA_MODE`：源码问答建议保持 `true`

### OneBot

- `ONEBOT_WS_URL`：NapCatQQ 的本地 WebSocket 地址
- `ONEBOT_ACCESS_TOKEN`：NapCatQQ token
- `ONEBOT_SELF_ID`：可选，留空时自动探测
- `ONEBOT_REPLY_MODE`：当前推荐 `send_msg`

### 图片

- `ATTACHMENT_DIR`：收到图片后的本地临时目录
- `MAX_IMAGE_ATTACHMENTS`：单条消息最多转给 Codex 的图片数量

### 范围控制

- `QQ_TARGET_GROUPS`：可选，用于限制允许回复的群

## 运维说明

- 这套桥接程序不支持热加载，代码修改后需要重启 `node src/index.js`
- 会话历史保存在本地，除非执行 `/reset`，否则后续消息会继承上下文
- 如果 `KNOWLEDGE_ROOT` 指向一个很大的父目录，回答会更慢，也更容易发散

## 故障排查

### OneBot 已连接，但私聊或群聊没有触发回复

检查：

- 当前 QQ 号是否真的登录在 QQ NT 里
- NapCatQQ 是否仍然适配当前 QQ NT 版本
- 群消息是否真的 `@了机器人`
- `QQ_TARGET_GROUPS` 是否把该群过滤掉了

### 机器人提示 `spawn codex ENOENT`

说明桥接进程找不到 Codex 可执行入口。

处理方法：

- 如果终端里直接能跑 `codex`，先设置 `CODEX_BIN=codex`
- 否则把 `CODEX_BIN` 改成真实可执行路径
- 在部分环境里可以把 `CODEX_BIN` 指向 `node.exe`，再由代码转调 `@openai/codex/bin/codex.js`

### 机器人提示 `Codex execution failed`

检查：

- 同一 Windows 用户会话里 Codex CLI 是否能正常使用
- 当前账号是否仍有权限访问知识目录
- Codex 的登录态是否有效

### 文本可用，但图片问答失败

检查：

- NapCatQQ 是否真的上报了图片消息段
- `ATTACHMENT_DIR` 是否可写
- 终端里是否出现 `attachments received: total=1, images=1, downloaded=1`
- 本机 Codex CLI 版本是否支持 `codex exec -i`

### 回复里还是暴露了太多本地信息

可以这样降低风险：

- 缩小 `KNOWLEDGE_ROOT` 的范围
- 使用更安全的 `KNOWLEDGE_LABEL`
- 在 [src/engine/message-engine.js](./src/engine/message-engine.js) 中继续加强清洗规则

## 常用文件和目录

- `.env`
- `.env.example`
- `.env.napcat.example`
- `data/sessions.json`
- `data/attachments/`
- `logs/stdout.log`
- `logs/stderr.log`

## 相关文档

- [README.md](./README.md)
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- [docs/NAPCAT_SETUP.md](./docs/NAPCAT_SETUP.md)
- [docs/NAPCAT_CHECKLIST.md](./docs/NAPCAT_CHECKLIST.md)
