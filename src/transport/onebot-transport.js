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
      const headers = {};
      if (this.config.onebot.accessToken) {
        headers.Authorization = `Bearer ${this.config.onebot.accessToken}`;
      }

      const socket = new WebSocket(this.config.onebot.wsUrl, { headers });
      this.socket = socket;

      socket.on('open', () => {
        process.stdout.write(`onebot connected: ${this.config.onebot.wsUrl}\n`);
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
        reject(err);
      });

      socket.on('close', (code, reason) => {
        process.stderr.write(`onebot disconnected: ${code} ${String(reason || '')}\n`);
      });
    });

    await this.detectSelfId();
  }

  async handlePayload(payload) {
    if (payload?.echo && this.pending.has(payload.echo)) {
      const deferred = this.pending.get(payload.echo);
      this.pending.delete(payload.echo);
      if (payload.status === 'failed') {
        deferred.reject(new Error(payload?.wording || payload?.message || 'onebot api failed'));
      } else {
        deferred.resolve(payload);
      }
      return;
    }

    if (payload?.post_type !== 'message') return;

    const message = mapOneBotMessage(payload, this.config, this.selfId, this);
    if (!message) return;
    process.stdout.write(`onebot inbound: type=${message.chatType} conversation=${message.conversationId} sender=${message.senderId} text=${JSON.stringify(String(message.text || '').slice(0, 80))}\n`);
    if (!this.handlers.inbound) return;
    await this.handlers.inbound(message);
  }

  async callApi(action, params) {
    const echo = `echo-${Date.now()}-${++this.echoCounter}`;
    const body = {
      action,
      params,
      echo,
    };

    return await new Promise((resolve, reject) => {
      this.pending.set(echo, { resolve, reject });
      this.socket.send(JSON.stringify(body), (err) => {
        if (err) {
          this.pending.delete(echo);
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
}

function mapOneBotMessage(payload, config, selfId, transportRef) {
  const messageType = String(payload.message_type || '').trim().toLowerCase();
  const rawText = extractOneBotText(payload.message);
  const attachments = extractAttachments(payload.message);
  const userId = stringifyId(payload.user_id);

  if (messageType === 'group') {
    const groupId = stringifyId(payload.group_id);
    if (config.qq.targetGroups.length > 0 && !config.qq.targetGroups.includes(groupId)) {
      return null;
    }

    const mentioned = isMentioningSelf(payload.message, selfId);
    if (!mentioned) return null;

    return createInboundMessage({
      transport: 'onebot',
      conversationId: `group:${groupId}`,
      senderId: userId,
      chatType: 'group',
      messageId: stringifyId(payload.message_id) || `group-${groupId}-${Date.now()}`,
      text: sanitizeGroupText(rawText, selfId),
      attachments,
      transportRef,
      mentioned,
      timestampMs: Number(payload.time || 0) * 1000 || Date.now(),
    });
  }

  if (messageType === 'private') {
    return createInboundMessage({
      transport: 'onebot',
      conversationId: `private:${userId}`,
      senderId: userId,
      chatType: 'private',
      messageId: stringifyId(payload.message_id) || `private-${userId}-${Date.now()}`,
      text: rawText,
      attachments,
      transportRef,
      mentioned: true,
      timestampMs: Number(payload.time || 0) * 1000 || Date.now(),
    });
  }

  return null;
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
