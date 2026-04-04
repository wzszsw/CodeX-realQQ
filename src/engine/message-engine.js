import fs from 'node:fs';
import path from 'node:path';
import { splitReplyText } from '../model.js';
import { runCodex } from '../provider/codex-runner.js';

export class MessageEngine {
  constructor(config, transport, sessionStore) {
    this.config = config;
    this.transport = transport;
    this.sessionStore = sessionStore;
  }

  async handleInbound(message) {
    const text = String(message.text || '').trim();
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    if (!text && attachments.length === 0) return;
    process.stdout.write(`engine inbound: conversation=${message.conversationId} text=${JSON.stringify(text.slice(0, 80))} attachments=${attachments.length}\n`);

    if (isIdentityQuestion(text)) {
      await this.reply(message.conversationId, buildIdentityReply(this.config.knowledgeLabel));
      return;
    }

    if (isSensitiveMetaQuestion(text)) {
      await this.reply(message.conversationId, buildSensitiveMetaRefusal());
      return;
    }

    if (text === '/help') {
      await this.reply(message.conversationId, [
        '可用命令',
        '/help',
        '/status',
        '/reset',
        '直接发送普通问题即可交给 Codex 处理。',
      ].join('\n'));
      return;
    }

    if (text === '/status') {
      const session = this.sessionStore.getConversation(message.conversationId);
      await this.reply(message.conversationId, [
        '当前状态',
        `conversation: ${session.id}`,
        `history: ${session.history.length}`,
        `knowledge: ${this.config.knowledgeLabel}`,
        `mode: ${this.config.readOnlyQaMode ? 'read-only qa' : 'normal'}`,
      ].join('\n'));
      return;
    }

    if (text === '/reset') {
      const session = this.sessionStore.getConversation(message.conversationId);
      session.history = [];
      session.updatedAt = new Date().toISOString();
      this.sessionStore.save();
      await this.reply(message.conversationId, '已清空当前会话历史。');
      return;
    }

    this.sessionStore.appendMessage(message.conversationId, 'user', text || buildAttachmentOnlyPrompt(attachments));
    const session = this.sessionStore.getConversation(message.conversationId);

    await this.reply(message.conversationId, '处理中...');

    const imagePaths = await materializeImageAttachments(this.config, message);
    if (attachments.length > 0) {
      process.stdout.write(`attachments received: total=${attachments.length}, images=${attachments.filter((item) => item?.kind === 'image').length}, downloaded=${imagePaths.length}\n`);
    }
    const promptText = text || buildAttachmentOnlyPrompt(attachments);
    const result = await runCodex(this.config, session, promptText, { imagePaths });
    if (!result.ok) {
      await this.reply(message.conversationId, [
        'Codex 执行失败',
        `error: ${result.error || '(unknown)'}`,
        result.logs.length ? `logs: ${result.logs.join(' | ')}` : '',
      ].filter(Boolean).join('\n'));
      return;
    }

    const rawAnswer = this.config.showReasoning && result.reasonings.length
      ? ['[Reasoning]', result.reasonings.join('\n\n'), '', '[Answer]', result.text].join('\n')
      : result.text || '已完成，但没有返回文本。';
    const answer = sanitizeReplyText(rawAnswer, this.config);

    this.sessionStore.appendMessage(message.conversationId, 'assistant', answer);
    await this.reply(message.conversationId, answer);
  }

  async reply(conversationId, text) {
    const chunks = splitReplyText(text, this.config.maxReplyChars);
    for (const chunk of chunks) {
      try {
        await this.transport.sendText(conversationId, chunk);
      } catch (err) {
        process.stderr.write(`reply failed: conversation=${conversationId} error=${err instanceof Error ? err.message : String(err)}\n`);
        throw err;
      }
    }
  }
}

function sanitizeReplyText(text, config) {
  let output = String(text || '');
  const knowledgeRoot = String(config.knowledgeRoot || '').trim();
  const knowledgeLabel = String(config.knowledgeLabel || 'knowledge-base').trim() || 'knowledge-base';

  if (knowledgeRoot) {
    const escapedRoot = escapeRegex(knowledgeRoot.replace(/\//g, '\\'));
    output = output.replace(new RegExp(escapedRoot, 'gi'), knowledgeLabel);
    const normalizedRoot = knowledgeRoot.replace(/\\/g, '/');
    output = output.replace(new RegExp(escapeRegex(normalizedRoot), 'gi'), knowledgeLabel);
  }

  output = output.replace(/[A-Za-z]:\\[^\s"'`]+/g, knowledgeLabel);
  output = output.replace(/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){2,}/g, knowledgeLabel);
  return output.trim();
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildAttachmentOnlyPrompt(attachments) {
  const imageCount = Array.isArray(attachments) ? attachments.filter((item) => item?.kind === 'image').length : 0;
  if (imageCount > 0) {
    return `请分析这${imageCount}张图片并回答用户问题。`;
  }
  return '请根据附件内容回答用户问题。';
}

async function materializeImageAttachments(config, message) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const images = attachments
    .filter((item) => item?.kind === 'image')
    .slice(0, config.maxImageAttachments);

  if (images.length === 0) return [];

  const baseDir = path.join(config.attachmentDir, sanitizePathSegment(message.conversationId), sanitizePathSegment(message.messageId || String(Date.now())));
  fs.mkdirSync(baseDir, { recursive: true });

  const output = [];
  for (let index = 0; index < images.length; index += 1) {
    const item = images[index];
    const filePath = path.join(baseDir, `${String(index + 1).padStart(2, '0')}${resolveImageExtension(item)}`);
    const saved = await saveImageAttachment(message, item, filePath);
    if (saved) {
      output.push(saved);
    }
  }
  return output;
}

async function saveImageAttachment(message, item, targetPath) {
  if (item?.url) {
    const saved = await downloadToFile(item.url, targetPath);
    if (saved) return saved;
  }

  if (message.transportRef && typeof message.transportRef.resolveImageFile === 'function' && item?.file) {
    try {
      const resolved = await message.transportRef.resolveImageFile(item.file);
      if (resolved?.file && fs.existsSync(resolved.file)) {
        fs.copyFileSync(resolved.file, targetPath);
        return targetPath;
      }
      if (resolved?.url) {
        const saved = await downloadToFile(resolved.url, targetPath);
        if (saved) return saved;
      }
    } catch {
    }
  }

  return '';
}

async function downloadToFile(url, targetPath) {
  try {
    const response = await fetch(url);
    if (!response.ok) return '';
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(targetPath, Buffer.from(arrayBuffer));
    return targetPath;
  } catch {
    return '';
  }
}

function resolveImageExtension(item) {
  const byUrl = extFromUrl(item?.url);
  if (byUrl) return byUrl;
  const byFile = path.extname(String(item?.file || '').trim());
  return byFile || '.jpg';
}

function extFromUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    const ext = path.extname(parsed.pathname || '');
    return ext || '';
  } catch {
    return '';
  }
}

function sanitizePathSegment(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .slice(0, 120);
}

function isIdentityQuestion(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;

  const exactMatches = new Set([
    '你是谁',
    '你是干什么的',
    '你是做什么的',
    '介绍下你自己',
    '介绍一下你自己',
    '介绍下自己',
    '介绍一下自己',
    '你能干什么',
    '你能做什么',
    'what are you',
    'who are you',
  ]);

  return exactMatches.has(value);
}

function buildIdentityReply(knowledgeLabel) {
  const label = String(knowledgeLabel || '知识库').trim() || '知识库';
  return [
    `我是 ${label} 的问答助手。`,
    '',
    '我可以回答这类问题：',
    `- ${label} 的功能、定位和概念`,
    '- API / DSL 的写法和用法',
    '- 查询、更新、删除、逻辑删除等机制',
    '- 注解、配置、策略扩展',
    '- 常见场景的示例写法与行为说明',
    '',
    '你可以直接问具体问题。',
  ].join('\n');
}

function isSensitiveMetaQuestion(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;

  const patterns = [
    /system\s*prompt/,
    /\bprompt\b.*(输出|泄露|打印|展示|show|print|dump|reveal)/,
    /(输出|打印|展示|泄露).*(system|prompt|提示词|系统提示|系统指令|隐藏指令|内部指令)/,
    /(推测|猜测|还原|复原).*(system|prompt|提示词|系统提示|系统指令|隐藏指令|内部指令)/,
    /(当前|所有|完整|全部).*(消息|message|history|聊天记录|上下文|会话)/,
    /(输出|打印|展示|泄露).*(所有消息|全部消息|完整消息|历史消息|上下文|会话记录|memory|记忆)/,
    /(调试|debug).*(消息|history|prompt|提示词|上下文|会话)/,
    /(developer|system).*(message|messages|prompt|instruction|instructions)/,
    /(内部配置|隐藏配置|环境变量|token|access[_ -]?token|webui token|secret|密钥)/,
    /(把.*(历史|上下文|消息|prompt|提示词).*(发出来|贴出来|给我))/,
  ];

  return patterns.some((pattern) => pattern.test(value));
}

function buildSensitiveMetaRefusal() {
  return [
    '这个请求我不能提供。',
    '',
    '我不会输出或复原这些内容：',
    '- system prompt、提示词或内部指令',
    '- 会话历史、隐藏消息或调试信息',
    '- token、密钥、环境变量或内部配置',
    '',
    '如果你想了解能力范围，可以直接问业务问题、API 用法或机制说明。',
  ].join('\n');
}
