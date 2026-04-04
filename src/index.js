import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { MessageEngine } from './engine/message-engine.js';
import { FileSessionStore } from './session/file-session-store.js';
import { StdinTransport } from './transport/stdin-transport.js';
import { OneBotTransport } from './transport/onebot-transport.js';

const config = loadConfig();

fs.mkdirSync(path.dirname(config.sessionStoreFile), { recursive: true });

const transport = createTransport(config);
const sessionStore = new FileSessionStore(config.sessionStoreFile);
const engine = new MessageEngine(config, transport, sessionStore);

transport.onInbound(async (message) => {
  try {
    await engine.handleInbound(message);
  } catch (err) {
    await transport.sendText(message.conversationId, `内部错误: ${err instanceof Error ? err.message : String(err)}`);
  }
});

console.log(`CodeX-realQQ starting`);
console.log(`mode: ${config.appMode}`);
console.log(`knowledge label: ${config.knowledgeLabel}`);
console.log(`knowledge root: ${config.knowledgeRoot}`);
console.log(`read-only qa: ${config.readOnlyQaMode}`);

await transport.start();

function createTransport(config) {
  if (config.appMode === 'stdin') {
    return new StdinTransport();
  }
  if (config.appMode === 'onebot') {
    return new OneBotTransport(config);
  }
  throw new Error(`unsupported APP_MODE: ${config.appMode}`);
}
