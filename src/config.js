import 'dotenv/config';
import path from 'node:path';

const ROOT = process.cwd();

export function loadConfig() {
  const sessionStoreFile = resolveLocalPath(process.env.SESSION_STORE_FILE || './data/sessions.json');

  return {
    rootDir: ROOT,
    appMode: String(process.env.APP_MODE || 'stdin').trim().toLowerCase(),
    codexBin: String(process.env.CODEX_BIN || 'codex').trim() || 'codex',
    knowledgeRoot: resolveLocalPath(process.env.KNOWLEDGE_ROOT || '.'),
    knowledgeLabel: String(process.env.KNOWLEDGE_LABEL || 'knowledge-base').trim() || 'knowledge-base',
    readOnlyQaMode: String(process.env.READ_ONLY_QA_MODE || 'true').toLowerCase() !== 'false',
    sessionStoreFile,
    attachmentDir: resolveLocalPath(process.env.ATTACHMENT_DIR || './data/attachments'),
    maxReplyChars: parsePositiveInt(process.env.MAX_REPLY_CHARS, 1500),
    maxHistoryMessages: parsePositiveInt(process.env.MAX_HISTORY_MESSAGES, 20),
    maxImageAttachments: parsePositiveInt(process.env.MAX_IMAGE_ATTACHMENTS, 3),
    showReasoning: String(process.env.SHOW_REASONING || 'false').toLowerCase() === 'true',
    qq: {
      accountUin: String(process.env.QQ_ACCOUNT_UIN || '').trim(),
      targetGroups: parseCsv(process.env.QQ_TARGET_GROUPS || ''),
      clientMode: String(process.env.QQ_CLIENT_MODE || 'windows-ui').trim(),
      pollIntervalMs: parsePositiveInt(process.env.QQ_POLL_INTERVAL_MS, 1500),
    },
    onebot: {
      wsUrl: String(process.env.ONEBOT_WS_URL || 'ws://127.0.0.1:3001').trim(),
      accessToken: String(process.env.ONEBOT_ACCESS_TOKEN || '').trim(),
      selfId: String(process.env.ONEBOT_SELF_ID || '').trim(),
      replyMode: String(process.env.ONEBOT_REPLY_MODE || 'send_msg').trim().toLowerCase(),
    },
  };
}

function resolveLocalPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return ROOT;
  return path.isAbsolute(raw) ? raw : path.resolve(ROOT, raw);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
