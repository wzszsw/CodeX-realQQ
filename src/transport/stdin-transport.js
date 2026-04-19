import readline from 'node:readline';
import { createInboundMessage, createReplyPayload, createStructuredReplyPayload } from '../model.js';

export class StdinTransport {
  constructor() {
    this.handlers = { inbound: null };
  }

  onInbound(handler) {
    this.handlers.inbound = handler;
  }

  async start() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    process.stdout.write('stdin transport ready. type a question and press enter.\n');

    rl.on('line', async (line) => {
      const text = String(line || '').trim();
      if (!text) return;
      if (!this.handlers.inbound) return;
      const event = createInboundMessage({
        transport: 'stdin',
        conversationId: 'stdin:default',
        senderId: 'local-user',
        chatType: 'private',
        messageId: `stdin-${Date.now()}`,
        text,
        mentioned: true,
        timestampMs: Date.now(),
      });
      await this.handlers.inbound(event);
    });
  }

  async sendText(conversationId, text) {
    const payload = createReplyPayload({ conversationId, text });
    process.stdout.write(`\n[reply:${payload.conversationId}]\n${payload.text}\n\n`);
  }

  async sendMessage(conversationId, message) {
    const payload = createStructuredReplyPayload({ conversationId, message });
    const rendered = payload.message.map((segment) => {
      if (segment?.type === 'text') return String(segment?.data?.text || '');
      if (segment?.type === 'image') return `[image:${String(segment?.data?.file || '')}]`;
      return `[segment:${String(segment?.type || 'unknown')}]`;
    }).filter(Boolean).join('\n');
    process.stdout.write(`\n[reply:${payload.conversationId}]\n${rendered}\n\n`);
  }
}
