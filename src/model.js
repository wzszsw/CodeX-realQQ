export function createInboundMessage(input = {}) {
  return {
    transport: String(input.transport || '').trim() || 'unknown',
    conversationId: String(input.conversationId || '').trim(),
    senderId: String(input.senderId || '').trim(),
    chatType: String(input.chatType || '').trim() || 'private',
    messageId: String(input.messageId || '').trim(),
    text: String(input.text || ''),
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    transportRef: input.transportRef || null,
    mentioned: Boolean(input.mentioned),
    timestampMs: Number.isFinite(input.timestampMs) ? input.timestampMs : Date.now(),
  };
}

export function createReplyPayload(input = {}) {
  return {
    conversationId: String(input.conversationId || '').trim(),
    text: String(input.text || '').trim(),
  };
}

export function splitReplyText(text, limit = 1500) {
  const value = String(text || '').trim();
  if (!value) return [''];
  if (value.length <= limit) return [value];

  const chunks = [];
  let rest = value;
  while (rest.length > limit) {
    let splitAt = rest.lastIndexOf('\n', limit);
    if (splitAt < Math.floor(limit * 0.5)) splitAt = rest.lastIndexOf(' ', limit);
    if (splitAt < Math.floor(limit * 0.5)) splitAt = limit;
    chunks.push(rest.slice(0, splitAt).trim());
    rest = rest.slice(splitAt).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
