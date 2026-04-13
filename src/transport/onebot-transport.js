import WebSocket from 'ws';
import { createInboundMessage, createReplyPayload } from '../model.js';

export class OneBotTransport {
  constructor(config) {
    this.config = config;
    this.handlers = { inbound: null };
    this.socket = null;
    this.echoCounter = 0;
    this.pending = new Map();
    this.selfId = String(config.onebot.selfId || '').trim();
    this.pendingImageContexts = new Map();
    this.recentInboundContexts = new Map();
  }

  onInbound(handler) {
    this.handlers.inbound = handler;
  }

  async start() {
    await this.connect();
  }

  async sendText(conversationId, text) {
    const payload = createReplyPayload({ conversationId, text });
    const target = parseConversationId(payload.conversationId);
    if (!target) {
      throw new Error(`unsupported conversation id: ${payload.conversationId}`);
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('onebot websocket not connected');
    }

    process.stdout.write(`onebot outbound: conversation=${payload.conversationId} chars=${payload.text.length}\n`);

    if (this.config.onebot.replyMode === 'send_msg') {
      await this.callApi('send_msg', {
        message_type: target.chatType === 'group' ? 'group' : 'private',
        group_id: target.chatType === 'group' ? normalizeNumericId(target.targetId) : undefined,
        user_id: target.chatType === 'private' ? normalizeNumericId(target.targetId) : undefined,
        message: payload.text,
      });
      return;
    }

    if (target.chatType === 'group') {
      await this.callApi('send_group_msg', {
        group_id: normalizeNumericId(target.targetId),
        message: payload.text,
      });
      return;
    }

    await this.callApi('send_private_msg', {
      user_id: normalizeNumericId(target.targetId),
      message: payload.text,
    });
  }

  async connect() {
    await new Promise((resolve, reject) => {
      let settled = false;
      const headers = {};
      if (this.config.onebot.accessToken) {
        headers.Authorization = `Bearer ${this.config.onebot.accessToken}`;
      }

      const socket = new WebSocket(this.config.onebot.wsUrl, { headers });
      this.socket = socket;

      socket.on('open', () => {
        process.stdout.write(`onebot connected: ${this.config.onebot.wsUrl}\n`);
        settled = true;
        resolve();
      });

      socket.on('message', async (raw) => {
        try {
          const payload = JSON.parse(raw.toString('utf8'));
          await this.handlePayload(payload);
        } catch (err) {
          process.stderr.write(`onebot payload error: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      });

      socket.on('error', (err) => {
        if (!settled) settled = true;
        reject(err);
      });

      socket.on('close', (code, reason) => {
        const message = `onebot disconnected: ${code} ${String(reason || '')}`.trim();
        process.stderr.write(`${message}\n`);
        this.rejectPending(new Error(message));
        this.socket = null;
        if (!settled) {
          settled = true;
          reject(new Error(message));
        }
      });
    });

    await this.detectSelfId();
  }

  async handlePayload(payload) {
    if (payload?.echo && this.pending.has(payload.echo)) {
      const deferred = this.pending.get(payload.echo);
      this.pending.delete(payload.echo);
      clearTimeout(deferred.timeout);
      if (payload.status === 'failed') {
        deferred.reject(new Error(payload?.wording || payload?.message || 'onebot api failed'));
      } else {
        deferred.resolve(payload);
      }
      return;
    }

    if (payload?.post_type !== 'message') return;

    const message = await mapOneBotMessage(payload, this.config, this.selfId, this);
    if (!message) return;
    if (message.chatType === 'group' && !message.deliverable) {
      this.storeRecentInboundContext(message);
      process.stdout.write(
        `onebot buffered-context: conversation=${message.conversationId} sender=${message.senderId} text=${JSON.stringify(String(message.text || '').slice(0, 80))} attachments=${Array.isArray(message.attachments) ? message.attachments.length : 0}\n`,
      );
      return;
    }

    const recentContextMessages = this.takeRecentInboundContext(message);
    const contextualizedMessage = recentContextMessages.length > 0
      ? mergeMessageWithRecentContext(message, recentContextMessages, this.config.maxImageAttachments)
      : message;
    const quotedMessage = mergeMessageWithQuoteContext(contextualizedMessage);
    const mergedMessage = this.processInboundContext(quotedMessage);
    if (!mergedMessage) return;
    await this.dispatchInbound(mergedMessage);
  }

  async callApi(action, params) {
    const echo = `echo-${Date.now()}-${++this.echoCounter}`;
    const body = {
      action,
      params,
      echo,
    };

    return await new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('onebot websocket not connected'));
        return;
      }

      const timeout = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`onebot api timeout: ${action}`));
      }, this.config.onebot.apiTimeoutMs);
      timeout.unref?.();

      this.pending.set(echo, { resolve, reject, timeout });
      this.socket.send(JSON.stringify(body), (err) => {
        if (err) {
          this.pending.delete(echo);
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }

  async detectSelfId() {
    if (this.selfId) return this.selfId;
    try {
      const response = await this.callApi('get_login_info', {});
      const detected = stringifyId(response?.data?.user_id || response?.data?.uin || '');
      if (detected) {
        this.selfId = detected;
        process.stdout.write(`onebot self id: ${this.selfId}\n`);
      }
    } catch (err) {
      process.stderr.write(`onebot self-id detection failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    return this.selfId;
  }

  async resolveImageFile(file) {
    const fileId = stringifyId(file);
    if (!fileId) return null;

    try {
      const response = await this.callApi('get_image', { file: fileId });
      const resolved = normalizeResolvedFile(response?.data);
      if (resolved) return resolved;
    } catch {
    }

    try {
      const response = await this.callApi('get_file', { file: fileId, type: 'image' });
      const resolved = normalizeResolvedFile(response?.data);
      if (resolved) return resolved;
    } catch {
    }

    return null;
  }

  async resolveQuotedMessage(messageId) {
    const quotedId = stringifyId(messageId);
    if (!quotedId) return null;

    try {
      const response = await this.callApi('get_msg', { message_id: quotedId });
      return normalizeQuotedMessage(response?.data);
    } catch (err) {
      process.stderr.write(`onebot quote resolve failed: messageId=${quotedId} error=${err instanceof Error ? err.message : String(err)}\n`);
      return null;
    }
  }

  processInboundContext(message) {
    const key = buildContextKey(message);
    const text = String(message.text || '').trim();
    const hasImages = Array.isArray(message.attachments) && message.attachments.some((item) => item?.kind === 'image');
    const now = Number(message.timestampMs) || Date.now();
    const pending = key ? this.pendingImageContexts.get(key) : null;

    if (pending && pending.expiresAt <= now) {
      this.clearPendingImageContext(key);
    }

    if (hasImages && !text) {
      this.storePendingImageContext(key, message);
      return null;
    }

    if (message.deliverable && pending && pending.expiresAt > now) {
      this.clearPendingImageContext(key);
      return {
        ...message,
        attachments: mergeImageAttachments(
          pending.message.attachments,
          message.attachments,
          this.config.maxImageAttachments,
        ),
      };
    }

    return message.deliverable ? message : null;
  }

  storePendingImageContext(key, message) {
    if (!key) return;

    const current = this.pendingImageContexts.get(key);
    if (current?.timer) {
      clearTimeout(current.timer);
    }

    const mergedMessage = current
      ? {
          ...message,
          attachments: mergeImageAttachments(
            current.message.attachments,
            message.attachments,
            this.config.maxImageAttachments,
          ),
        }
      : message;

    const windowMs = this.config.inboundImageContextWindowMs;
    const expiresAt = (Number(message.timestampMs) || Date.now()) + windowMs;
    const deliverOnTimeout = message.chatType === 'private' || message.mentioned;
    const timer = setTimeout(async () => {
      const latest = this.pendingImageContexts.get(key);
      if (!latest) return;
      this.pendingImageContexts.delete(key);
      if (!latest.deliverOnTimeout) return;
      try {
        await this.dispatchInbound(latest.message);
      } catch (err) {
        process.stderr.write(`onebot delayed inbound failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }, windowMs);
    timer.unref?.();

    this.pendingImageContexts.set(key, {
      message: mergedMessage,
      expiresAt,
      deliverOnTimeout,
      timer,
    });

    process.stdout.write(
      `onebot pending-image: conversation=${message.conversationId} sender=${message.senderId} images=${mergedMessage.attachments.length} deliverOnTimeout=${deliverOnTimeout}\n`,
    );
  }

  clearPendingImageContext(key) {
    if (!key) return;
    const current = this.pendingImageContexts.get(key);
    if (current?.timer) {
      clearTimeout(current.timer);
    }
    this.pendingImageContexts.delete(key);
  }

  storeRecentInboundContext(message) {
    const key = buildContextKey(message);
    if (!key) return;

    const now = Number(message.timestampMs) || Date.now();
    const windowMs = this.config.recentInboundContextWindowMs;
    const maxMessages = this.config.recentInboundContextMaxMessages;
    const current = this.pruneRecentInboundContext(key, now);

    current.push({
      text: String(message.text || '').trim(),
      attachments: normalizeImageAttachments(message.attachments),
      timestampMs: now,
    });

    const trimmed = current.slice(-Math.max(1, maxMessages));
    this.recentInboundContexts.set(key, trimmed);
  }

  takeRecentInboundContext(message) {
    const key = buildContextKey(message);
    if (!key) return [];
    const current = this.pruneRecentInboundContext(key, Number(message.timestampMs) || Date.now());
    this.recentInboundContexts.delete(key);
    return current;
  }

  pruneRecentInboundContext(key, now) {
    const current = Array.isArray(this.recentInboundContexts.get(key)) ? this.recentInboundContexts.get(key) : [];
    const windowMs = this.config.recentInboundContextWindowMs;
    const filtered = current.filter((item) => (now - Number(item.timestampMs || 0)) <= windowMs);
    if (filtered.length > 0) {
      this.recentInboundContexts.set(key, filtered);
    } else {
      this.recentInboundContexts.delete(key);
    }
    return filtered;
  }

  async dispatchInbound(message) {
    process.stdout.write(
      `onebot inbound: type=${message.chatType} conversation=${message.conversationId} sender=${message.senderId} text=${JSON.stringify(String(message.text || '').slice(0, 80))} attachments=${Array.isArray(message.attachments) ? message.attachments.length : 0}\n`,
    );
    if (!this.handlers.inbound) return;
    await this.handlers.inbound(message);
  }

  rejectPending(error) {
    for (const [echo, deferred] of this.pending.entries()) {
      this.pending.delete(echo);
      clearTimeout(deferred.timeout);
      try {
        deferred.reject(error);
      } catch {
      }
    }
  }
}

async function mapOneBotMessage(payload, config, selfId, transportRef) {
  const messageType = String(payload.message_type || '').trim().toLowerCase();
  const rawText = extractOneBotText(payload.message);
  const attachments = extractAttachments(payload.message);
  const quote = await extractQuote(payload.message, transportRef);
  const userId = stringifyId(payload.user_id);

  if (messageType === 'group') {
    const groupId = stringifyId(payload.group_id);
    if (config.qq.targetGroups.length > 0 && !config.qq.targetGroups.includes(groupId)) {
      return null;
    }

    const mentioned = isMentioningSelf(payload.message, selfId);
    return {
      ...createInboundMessage({
      transport: 'onebot',
      conversationId: `group:${groupId}`,
      senderId: userId,
      chatType: 'group',
      messageId: stringifyId(payload.message_id) || `group-${groupId}-${Date.now()}`,
      text: sanitizeGroupText(rawText, selfId),
      originalText: sanitizeGroupText(rawText, selfId),
      attachments,
      quote,
      transportRef,
      mentioned,
      timestampMs: Number(payload.time || 0) * 1000 || Date.now(),
      }),
      deliverable: mentioned,
    };
  }

  if (messageType === 'private') {
    return {
      ...createInboundMessage({
      transport: 'onebot',
      conversationId: `private:${userId}`,
      senderId: userId,
      chatType: 'private',
      messageId: stringifyId(payload.message_id) || `private-${userId}-${Date.now()}`,
      text: rawText,
      originalText: rawText,
      attachments,
      quote,
      transportRef,
      mentioned: true,
      timestampMs: Number(payload.time || 0) * 1000 || Date.now(),
      }),
      deliverable: true,
    };
  }

  return null;
}

function buildContextKey(message) {
  const conversationId = String(message?.conversationId || '').trim();
  const senderId = String(message?.senderId || '').trim();
  if (!conversationId || !senderId) return '';
  return `${conversationId}::${senderId}`;
}

function mergeImageAttachments(first, second, limit) {
  const merged = [...normalizeImageAttachments(first), ...normalizeImageAttachments(second)];
  const output = [];
  const seen = new Set();

  for (const item of merged) {
    const key = String(item.id || item.file || item.url || '').trim();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    output.push(item);
    if (output.length >= limit) break;
  }

  return output;
}

function normalizeImageAttachments(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => item?.kind === 'image');
}

function mergeMessageWithRecentContext(message, contextMessages, maxImageAttachments) {
  const recent = Array.isArray(contextMessages) ? contextMessages : [];
  if (recent.length === 0) return message;

  const contextText = buildRecentContextText(recent);
  const currentText = String(message.text || '').trim();
  const mergedText = contextText
    ? [contextText, currentText ? `本次提问：\n${currentText}` : '本次提问：\n请结合上面的上下文与图片回答。'].join('\n\n')
    : currentText;

  return {
    ...message,
    text: mergedText,
    originalText: String(message.originalText || message.text || '').trim(),
    attachments: mergeImageAttachments(
      recent.flatMap((item) => normalizeImageAttachments(item.attachments)),
      message.attachments,
      maxImageAttachments,
    ),
  };
}

function mergeMessageWithQuoteContext(message) {
  const quote = message?.quote && typeof message.quote === 'object' ? message.quote : null;
  if (!quote) return message;

  const quoteText = buildQuoteContextText(quote);
  if (!quoteText) return message;

  const currentText = String(message.text || '').trim();
  return {
    ...message,
    text: currentText
      ? [quoteText, `本次提问：\n${currentText}`].join('\n\n')
      : [quoteText, '本次提问：\n请结合引用内容回答。'].join('\n\n'),
  };
}

function buildRecentContextText(contextMessages) {
  const lines = contextMessages
    .map((item, index) => formatContextLine(item, index + 1))
    .filter(Boolean);

  if (lines.length === 0) return '';
  return ['最近聊天上下文（同一发送者）：', ...lines].join('\n');
}

function formatContextLine(item, index) {
  const text = String(item?.text || '').trim();
  const imageCount = normalizeImageAttachments(item?.attachments).length;
  const parts = [];

  if (text) parts.push(text);
  if (imageCount > 0) parts.push(`附${imageCount}张图片`);
  if (parts.length === 0) return '';

  return `${index}. ${parts.join('，')}`;
}

async function extractQuote(message, transportRef) {
  if (!Array.isArray(message)) return null;
  const replySegment = message.find((segment) => segment?.type === 'reply');
  const quotedMessageId = stringifyId(replySegment?.data?.id || replySegment?.data?.message_id || '');
  if (!quotedMessageId) return null;
  if (!transportRef || typeof transportRef.resolveQuotedMessage !== 'function') {
    return { messageId: quotedMessageId };
  }
  const resolved = await transportRef.resolveQuotedMessage(quotedMessageId);
  return resolved ? { messageId: quotedMessageId, ...resolved } : { messageId: quotedMessageId };
}

function buildQuoteContextText(quote) {
  const messageId = stringifyId(quote?.messageId || quote?.id || '');
  const senderName = String(quote?.senderName || '').trim();
  const text = String(quote?.text || '').trim();
  const imageCount = normalizeImageAttachments(quote?.attachments).length;
  const parts = [];

  if (senderName) parts.push(`发送者：${senderName}`);
  if (text) parts.push(`内容：\n${text}`);
  if (imageCount > 0) parts.push(`附件：${imageCount}张图片`);

  if (parts.length === 0) {
    return messageId ? `引用消息：message_id=${messageId}` : '';
  }

  return ['引用消息：', ...parts].join('\n');
}

function extractOneBotText(message) {
  if (typeof message === 'string') return message.trim();
  if (!Array.isArray(message)) return '';
  return message
    .map((segment) => {
      if (segment?.type === 'text') return String(segment?.data?.text || '');
      if (segment?.type === 'at') return `@${String(segment?.data?.qq || '')}`;
      return '';
    })
    .join('')
    .trim();
}

function extractAttachments(message) {
  if (!Array.isArray(message)) return [];
  return message
    .map((segment, index) => {
      if (segment?.type !== 'image') return null;
      const data = segment?.data || {};
      return {
        kind: 'image',
        id: stringifyId(data.file || data.file_id || `image-${index + 1}`),
        url: String(data.url || '').trim(),
        file: String(data.file || '').trim(),
        summary: '[image]',
      };
    })
    .filter(Boolean);
}

function isMentioningSelf(message, selfId) {
  if (!Array.isArray(message)) return false;
  if (!selfId) return true;
  return message.some((segment) => segment?.type === 'at' && stringifyId(segment?.data?.qq) === selfId);
}

function sanitizeGroupText(text, selfId) {
  const value = String(text || '').trim();
  if (!value || !selfId) return value;
  return value.replace(new RegExp(`@${escapeRegex(selfId)}`, 'g'), '').trim();
}

function parseConversationId(conversationId) {
  const raw = String(conversationId || '');
  const index = raw.indexOf(':');
  if (index <= 0) return null;
  const chatType = raw.slice(0, index);
  const targetId = raw.slice(index + 1);
  if (!targetId) return null;
  return { chatType, targetId };
}

function stringifyId(value) {
  return String(value ?? '').trim();
}

function normalizeNumericId(value) {
  const raw = stringifyId(value);
  const num = Number(raw);
  return Number.isFinite(num) ? num : raw;
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeResolvedFile(data) {
  if (!data || typeof data !== 'object') return null;
  const file = String(data.file || '').trim();
  const url = String(data.url || '').trim();
  const fileName = String(data.file_name || data.filename || '').trim();
  if (!file && !url) return null;
  return {
    file,
    url,
    fileName,
  };
}

function normalizeQuotedMessage(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    senderId: stringifyId(data.user_id || data.sender?.user_id || ''),
    senderName: String(data.sender?.card || data.sender?.nickname || '').trim(),
    text: extractOneBotText(data.message),
    attachments: extractAttachments(data.message),
    timestampMs: Number(data.time || 0) * 1000 || 0,
  };
}
