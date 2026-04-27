import { spawn } from 'node:child_process';
import { buildProviderPrompt } from './prompt.js';

export async function runClaude(config, session, userText, options = {}) {
  const imagePaths = Array.isArray(options.imagePaths) ? options.imagePaths : [];
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const prompt = buildClaudePrompt(config, userText, session, imagePaths);
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--add-dir',
    config.knowledgeRoot,
  ];

  const imageDirs = buildClaudeImageDirs(imagePaths);
  for (const dir of imageDirs) {
    args.push('--add-dir', dir);
  }

  if (config.readOnlyQaMode) {
    args.push('--permission-mode', 'plan');
  }

  return await new Promise((resolve) => {
    const child = spawn(String(config.claudeBin || 'claude').trim() || 'claude', args, {
      cwd: config.knowledgeRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let assistantText = '';
    let resultText = '';
    let threadId = null;
    const logs = [];
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

    const handleJsonLine = (line) => {
      const trimmed = String(line || '').trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed);
        if (event.type === 'system' && event.subtype === 'init') {
          threadId = event.session_id || threadId;
          emitProgress({ stage: 'started', threadId });
          return;
        }
        if (event.type === 'assistant') {
          const text = extractAssistantText(event.message);
          if (text) {
            assistantText = text;
            emitProgress({ stage: 'thinking' });
          }
          return;
        }
        if (event.type === 'result') {
          resultText = String(event.result || '').trim();
          threadId = event.session_id || threadId;
          if (event.subtype === 'success') {
            emitProgress({ stage: 'completed', threadId, heartbeatCount });
          } else {
            logs.push(trimmed);
            emitProgress({ stage: 'failed', threadId, heartbeatCount });
          }
          return;
        }
        logs.push(trimmed);
      } catch {
        logs.push(trimmed);
      }
    };

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdoutBuf += text;
      markActivity();
      for (const line of text.split(/\r?\n/)) {
        handleJsonLine(line);
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderrBuf += text;
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
        logs: buildLogs(stderrBuf, logs, err.message),
        threadId,
      });
    });

    child.on('close', (exitCode, signal) => {
      clearInterval(heartbeat);
      const ok = exitCode === 0;
      const finalText = sanitizeFinalAnswer(resultText || assistantText);
      emitProgress({ stage: ok ? 'completed' : 'failed', threadId, heartbeatCount });
      resolve({
        ok,
        error: ok ? '' : `exit=${exitCode}${signal ? ` signal=${signal}` : ''}`,
        text: finalText,
        reasonings: [],
        logs: buildLogs(stderrBuf, logs),
        threadId,
      });
    });
  });
}

function buildClaudePrompt(config, userText, session, imagePaths) {
  const basePrompt = buildProviderPrompt(config, userText, session, []);
  if (imagePaths.length === 0) return basePrompt;
  const imageHints = imagePaths.map((filePath, index) => `图片${index + 1} 文件路径：${String(filePath || '').replace(/\\/g, '/')}`);
  return [
    basePrompt,
    '你可以读取上面这些本地图片文件并结合它们回答问题。如果无法读取图片，请明确说明。',
    imageHints.join('\n'),
  ].join('\n\n');
}

function buildClaudeImageDirs(imagePaths) {
  return [...new Set((Array.isArray(imagePaths) ? imagePaths : [])
    .map((filePath) => String(filePath || '').trim())
    .filter(Boolean)
    .map((filePath) => filePath.replace(/\\/g, '/').replace(/\/[^/]+$/, '')))];
}

function extractAssistantText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((item) => item?.type === 'text')
    .map((item) => String(item?.text || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function buildLogs(stderrBuf, logs, ...extraLogs) {
  const stderrLines = String(stderrBuf || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return [...new Set([...stderrLines, ...(Array.isArray(logs) ? logs : []), ...extraLogs.filter(Boolean)])];
}

function sanitizeFinalAnswer(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  return value
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => !isProgressNarration(line.trim()))
    .join('\n')
    .trim();
}

function isProgressNarration(line) {
  const value = String(line || '').toLowerCase();
  return [
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
  ].some((pattern) => pattern.test(value));
}
