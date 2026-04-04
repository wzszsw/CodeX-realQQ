import fs from 'node:fs';
import path from 'node:path';

export class FileSessionStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = loadJson(filePath, { conversations: {} });
  }

  getConversation(conversationId) {
    const key = String(conversationId || '').trim();
    if (!key) throw new Error('conversationId required');

    if (!this.state.conversations[key]) {
      this.state.conversations[key] = {
        id: key,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        history: [],
      };
      this.save();
    }

    return this.state.conversations[key];
  }

  appendMessage(conversationId, role, text) {
    const conversation = this.getConversation(conversationId);
    conversation.history.push({
      role,
      text: String(text || '').trim(),
      at: new Date().toISOString(),
    });
    conversation.updatedAt = new Date().toISOString();
    this.save();
    return conversation;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }
}

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}
