import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildProviderPrompt } from './prompt.js';

export async function runCodex(config, session, userText, options = {}) {
  const imagePaths = Array.isArray(options.imagePaths) ? options.imagePaths : [];
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const prompt = buildProviderPrompt(config, userText, session, imagePaths);
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--full-auto',
  ];
  for (const imagePath of imagePaths.slice(0, config.maxImageAttachments)) {
    args.push('-i', imagePath);
  }
  args.push('-C', config.knowledgeRoot, prompt);

  const spawnCommand = resolveCodexCommand(config.codexBin, args);

  return await new Promise((resolve) => {
    const child = spawn(spawnCommand.command, spawnCommand.args, {
      cwd: config.knowledgeRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let threadId = null;
    let lastAgentMessage = '';
    const reasonings = [];
    const logs = [];
    let reasoningCount = 0;
    let messageCount = 0;

    const emitProgress = (event) => {
      if (!onProgress || !event || typeof event !== 'object') return;
      onProgress(event);
    };

    emitProgress({ stage: 'started' });

    const handleLine = (line, source) => {
      const trimmed = String(line || '').trim();
      if (!trimmed) return;

      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const ev = JSON.parse(trimmed);
          if (ev.type === 'thread.started') {
            threadId = ev.thread_id || threadId;
            emitProgress({ stage: 'started', threadId });
            return;
          }
          if (ev.type === 'item.completed') {
            if (ev.item?.type === 'agent_message') {
              const text = extractAgentMessageText(ev.item);
              if (text) {
                lastAgentMessage = text;
                messageCount += 1;
                emitProgress({ stage: 'thinking', messageCount });
              }
              return;
            }
            if (ev.item?.type === 'reasoning') {
              const reasoning = extractReasoningText(ev.item);
              if (reasoning) {
                reasonings.push(reasoning);
                reasoningCount += 1;
                emitProgress({ stage: 'thinking', reasoningCount });
              }
              return;
            }
          }
          if (ev.type === 'error') {
            logs.push(typeof ev.error === 'string' ? ev.error : JSON.stringify(ev.error));
            emitProgress({ stage: 'failed' });
            return;
          }
          return;
        } catch {
          // keep falling through for non-json diagnostic lines
        }
      }

      if (source === 'stderr') {
        logs.push(trimmed);
      }
    };

    const onData = (chunk, source) => {
      let buffer = source === 'stdout' ? stdoutBuf : stderrBuf;
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line, source);
      if (source === 'stdout') stdoutBuf = buffer;
      else stderrBuf = buffer;
    };

    child.stdout.on('data', (chunk) => onData(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => onData(chunk, 'stderr'));

    child.on('error', (err) => {
      emitProgress({ stage: 'failed' });
      resolve({
        ok: false,
        error: err.message,
        text: '',
        reasonings,
        logs: [...logs, err.message],
        threadId,
      });
    });

    child.on('close', (exitCode, signal) => {
      if (stdoutBuf.trim()) handleLine(stdoutBuf, 'stdout');
      if (stderrBuf.trim()) handleLine(stderrBuf, 'stderr');

      const ok = exitCode === 0;
      const text = sanitizeFinalAnswer(lastAgentMessage);
      emitProgress({ stage: ok ? 'completed' : 'failed', threadId, messageCount, reasoningCount });

      resolve({
        ok,
        error: ok ? '' : `exit=${exitCode}${signal ? ` signal=${signal}` : ''}`,
        text,
        reasonings,
        logs,
        threadId,
      });
    });
  });
}

function extractAgentMessageText(item) {
  if (!item || typeof item !== 'object') return '';

  if (Array.isArray(item.content)) {
    const fromContent = item.content
      .map((part) => {
        if (part?.type === 'output_text') return part.text || '';
        if (part?.type === 'text') return part.text || '';
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('\n')
      .trim();
    if (fromContent) return fromContent;
  }

  if (typeof item.text === 'string' && item.text.trim()) {
    return item.text.trim();
  }

  if (typeof item.message === 'string' && item.message.trim()) {
    return item.message.trim();
  }

  return '';
}

function extractReasoningText(item) {
  if (!item || typeof item !== 'object') return '';
  if (typeof item.text === 'string' && item.text.trim()) return item.text.trim();

  if (Array.isArray(item.content)) {
    return item.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('\n')
      .trim();
  }

  return '';
}

function resolveCodexCommand(codexBin, args) {
  const command = String(codexBin || '').trim() || 'codex';
  if (process.platform === 'win32') {
    const lower = command.toLowerCase();
    if (lower.endsWith('node.exe')) {
      const codexScript = path.join(path.dirname(command), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (fs.existsSync(codexScript)) {
        return { command, args: [codexScript, ...args] };
      }
    }
  }
  return { command, args };
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

