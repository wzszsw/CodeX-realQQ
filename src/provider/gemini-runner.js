import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildProviderPrompt } from './prompt.js';

export async function runGemini(config, session, userText, options = {}) {
  const imagePaths = Array.isArray(options.imagePaths) ? options.imagePaths : [];
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const prompt = buildGeminiPrompt(config, userText, session, imagePaths);
  const args = ['--prompt', prompt, '--output-format', 'json'];
  for (const includeDir of buildGeminiIncludeDirs(config, imagePaths)) {
    args.push('--include-directories', includeDir);
  }

  if (config.geminiModel) {
    args.push('--model', config.geminiModel);
  }
  if (config.readOnlyQaMode) {
    args.push('--approval-mode', 'plan');
  }

  const spawnCommand = resolveGeminiCommand(config.geminiBin, args);

  return await new Promise((resolve) => {
    const child = spawn(spawnCommand.command, spawnCommand.args, {
      cwd: config.knowledgeRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let sawActivity = false;
    let heartbeatCount = 0;
    let lastActivityAt = Date.now();
    const silenceMs = Number(config.aiProgressSilenceMs) || 10000;
    const intervalMs = Math.max(Number(config.aiProgressIntervalMs) || 15000, silenceMs);

    const emitProgress = (event) => {
      if (!onProgress || !event || typeof event !== 'object') return;
      onProgress(event);
    };

    emitProgress({ stage: 'started' });

    const heartbeat = setInterval(() => {
      heartbeatCount += 1;
      const idleForMs = Date.now() - lastActivityAt;
      emitProgress({
        stage: sawActivity && idleForMs >= silenceMs ? 'waiting' : sawActivity ? 'thinking' : 'started',
        heartbeatCount,
      });
    }, intervalMs);

    const markActivity = () => {
      lastActivityAt = Date.now();
      if (sawActivity) return;
      sawActivity = true;
      emitProgress({ stage: 'thinking' });
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      markActivity();
    });

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
      markActivity();
    });

    child.on('error', (err) => {
      clearInterval(heartbeat);
      emitProgress({ stage: 'failed' });
      resolve({
        ok: false,
        error: err.message,
        text: '',
        reasonings: [],
        logs: buildLogs(stderrBuf, imagePaths, err.message),
        threadId: null,
      });
    });

    child.on('close', (exitCode, signal) => {
      clearInterval(heartbeat);
      const parsed = parseGeminiOutput(stdoutBuf);
      const ok = exitCode === 0;
      emitProgress({ stage: ok ? 'completed' : 'failed', heartbeatCount });

      resolve({
        ok,
        error: ok ? '' : `exit=${exitCode}${signal ? ` signal=${signal}` : ''}`,
        text: parsed.text,
        reasonings: parsed.reasonings,
        logs: buildLogs(stderrBuf, imagePaths, ...parsed.logs),
        threadId: parsed.threadId,
      });
    });
  });
}

function buildGeminiPrompt(config, userText, session, imagePaths) {
  const imageRefs = buildGeminiImageRefs(config, imagePaths);
  const basePrompt = buildProviderPrompt(config, userText, session, imageRefs);
  if (imageRefs.length === 0) return basePrompt;

  return [
    basePrompt,
    'Attached local files are referenced with @path syntax above. If an image cannot be read, say so clearly instead of guessing.',
  ].join('\n\n');
}

function buildLogs(stderrBuf, imagePaths, ...extraLogs) {
  const logs = [];
  const stderrLines = String(stderrBuf || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  logs.push(...stderrLines);
  if (imagePaths.length > 0) {
    logs.push('gemini adapter: image attachments passed via @path prompt references with include-directories for external files');
  }
  logs.push(...extraLogs.filter(Boolean));
  return dedupe(logs);
}

function buildGeminiIncludeDirs(config, imagePaths) {
  const rootDir = String(config.knowledgeRoot || '').trim();
  const dirs = [];

  for (const imagePath of Array.isArray(imagePaths) ? imagePaths : []) {
    const filePath = String(imagePath || '').trim();
    if (!filePath) continue;
    const dir = path.dirname(filePath);
    if (isInsideDir(rootDir, filePath)) continue;
    dirs.push(dir);
  }

  return dedupe(dirs).map((dir) => dir.replace(/\\/g, '/'));
}

function isInsideDir(rootDir, filePath) {
  if (!rootDir || !filePath) return false;
  const relativePath = path.relative(rootDir, filePath);
  return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function resolveGeminiCommand(geminiBin, args) {
  const command = String(geminiBin || '').trim() || 'gemini';
  if (process.platform === 'win32') {
    const normalized = command.replace(/\\/g, '/').toLowerCase();

    if (normalized.endsWith('/node.exe') || normalized.endsWith('node.exe')) {
      const geminiScript = path.join(path.dirname(command), 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
      if (fs.existsSync(geminiScript)) {
        return { command, args: ['--no-warnings=DEP0040', geminiScript, ...args] };
      }
    }

    if (!path.extname(command)) {
      const siblingNode = path.join(path.dirname(command), 'node.exe');
      const geminiScript = path.join(path.dirname(command), 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
      if (fs.existsSync(siblingNode) && fs.existsSync(geminiScript)) {
        return { command: siblingNode, args: ['--no-warnings=DEP0040', geminiScript, ...args] };
      }
    }
  }

  return { command, args };
}

function parseGeminiOutput(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return { text: '', reasonings: [], logs: [], threadId: null };
  }

  const blocks = parseJsonBlocks(trimmed);
  if (blocks.length === 0) {
    return {
      text: sanitizeFinalAnswer(trimmed),
      reasonings: [],
      logs: [],
      threadId: null,
    };
  }

  const textParts = [];
  const reasoningParts = [];
  const logs = [];
  let threadId = null;

  for (const block of blocks) {
    visitGeminiNode(block, { textParts, reasoningParts, logs });
    threadId = threadId || extractThreadId(block);
  }

  return {
    text: sanitizeFinalAnswer(textParts.join('\n').trim()),
    reasonings: dedupe(reasoningParts),
    logs: dedupe(logs),
    threadId,
  };
}

function parseJsonBlocks(text) {
  const blocks = [];

  try {
    blocks.push(JSON.parse(text));
    return blocks;
  } catch {
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) continue;
    try {
      blocks.push(JSON.parse(trimmed));
    } catch {
    }
  }

  return blocks;
}

function visitGeminiNode(node, state, parentKey = '') {
  if (node == null) return;

  if (typeof node === 'string') {
    const value = node.trim();
    if (!value) return;
    if (isReasoningKey(parentKey)) {
      state.reasoningParts.push(value);
      return;
    }
    if (isLogKey(parentKey)) {
      state.logs.push(value);
      return;
    }
    if (isTextKey(parentKey)) {
      state.textParts.push(value);
    }
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      visitGeminiNode(item, state, parentKey);
    }
    return;
  }

  if (typeof node !== 'object') return;

  const role = String(node.role || '').trim().toLowerCase();
  if (role === 'user') return;

  if (typeof node.error === 'string' && node.error.trim()) {
    state.logs.push(node.error.trim());
  }
  if (typeof node.message === 'string' && node.message.trim() && shouldTreatAsLog(node)) {
    state.logs.push(node.message.trim());
  }
  if (typeof node.text === 'string' && node.text.trim() && shouldTreatAsText(node)) {
    if (isReasoningNode(node)) {
      state.reasoningParts.push(node.text.trim());
    } else {
      state.textParts.push(node.text.trim());
    }
  }

  for (const [key, value] of Object.entries(node)) {
    visitGeminiNode(value, state, key);
  }
}

function shouldTreatAsText(node) {
  const type = String(node.type || '').trim().toLowerCase();
  if (!type) return true;
  if (['text', 'output_text', 'content', 'final', 'message', 'assistant'].includes(type)) return true;
  if (type.includes('reason')) return false;
  if (type.includes('log')) return false;
  if (type.includes('error')) return false;
  return true;
}

function shouldTreatAsLog(node) {
  const type = String(node.type || '').trim().toLowerCase();
  return type.includes('error') || type.includes('log') || type.includes('warning');
}

function isReasoningNode(node) {
  const type = String(node.type || '').trim().toLowerCase();
  return type.includes('reason') || type.includes('thought');
}

function isTextKey(key) {
  const value = String(key || '').trim().toLowerCase();
  return ['text', 'content', 'output', 'response', 'answer', 'message'].includes(value);
}

function isReasoningKey(key) {
  const value = String(key || '').trim().toLowerCase();
  return value.includes('reason') || value.includes('thought');
}

function isLogKey(key) {
  const value = String(key || '').trim().toLowerCase();
  return value.includes('error') || value.includes('warning') || value.includes('log');
}

function extractThreadId(node) {
  if (!node || typeof node !== 'object') return null;
  const candidates = [node.threadId, node.thread_id, node.sessionId, node.session_id];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value) return value;
  }
  return null;
}

function buildGeminiImageRefs(config, imagePaths) {
  return (Array.isArray(imagePaths) ? imagePaths : [])
    .map((filePath) => toGeminiPathRef(config.knowledgeRoot, filePath))
    .filter(Boolean);
}

function toGeminiPathRef(rootDir, filePath) {
  const absolutePath = String(filePath || '').trim();
  if (!absolutePath) return '';

  const normalizedRoot = String(rootDir || '').trim();
  let targetPath = absolutePath;
  if (normalizedRoot) {
    const relativePath = path.relative(normalizedRoot, absolutePath);
    if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
      targetPath = relativePath;
    }
  }

  return `@${targetPath.replace(/\\/g, '/')}`;
}

function sanitizeFinalAnswer(text) {
  const value = String(text || '').trim();
  if (!value) return '';

  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trimEnd());

  const filtered = lines.filter((line) => {
    const normalized = line.trim();
    if (!normalized) return true;
    return !isProgressNarration(normalized);
  });

  return filtered.join('\n').trim();
}

function isProgressNarration(line) {
  const value = line.toLowerCase();
  const patterns = [
    /^我先/,
    /^我已经/,
    /^我已/,
    /^接下来/,
    /^现在补/,
    /^关键实现已经/,
    /^测试里能看到/,
    /^i('|’)ll /,
    /^i will /,
    /^first,? i /,
    /^i (have )?confirmed /,
    /^i('?m| am) checking /,
    /^next,? i /,
  ];
  return patterns.some((pattern) => pattern.test(value));
}

function dedupe(items) {
  return [...new Set((Array.isArray(items) ? items : []).map((item) => String(item || '').trim()).filter(Boolean))];
}
