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
    '你可以直接问我这类问题：',
    '- 某个功能在哪里实现',
    '- 某个类、方法或配置是做什么的',
    '- 模块之间是怎么调用的',
    '- 一段代码或机制该怎么理解',
  ].join('\n');
}
