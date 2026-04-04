import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export async function runCodex(config, session, userText, options = {}) {
  const imagePaths = Array.isArray(options.imagePaths) ? options.imagePaths : [];
  const prompt = buildPrompt(config, userText, session, imagePaths);
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
    const messages = [];
    const finalAnswerMessages = [];
    const reasonings = [];
    const logs = [];

    const handleLine = (line, source) => {
      const trimmed = String(line || '').trim();
      if (!trimmed) return;

      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const ev = JSON.parse(trimmed);
          if (ev.type === 'thread.started') {
            threadId = ev.thread_id || threadId;
            return;
          }
          if (ev.type === 'item.completed') {
            if (ev.item?.type === 'agent_message') {
              const text = extractAgentMessageText(ev.item);
              if (text) {
                messages.push(text);
                finalAnswerMessages.push(text);
              }
              return;
            }
            if (ev.item?.type === 'reasoning') {
              const reasoning = extractReasoningText(ev.item);
              if (reasoning) reasonings.push(reasoning);
              return;
            }
          }
          if (ev.type === 'error') {
            logs.push(typeof ev.error === 'string' ? ev.error : JSON.stringify(ev.error));
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
      const text = finalAnswerMessages.join('\n\n').trim() || messages.join('\n\n').trim();

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

function buildPrompt(config, userText, session, imagePaths = []) {
  const history = Array.isArray(session.history) ? session.history : [];
  const historyText = history
    .slice(-Math.max(0, config.maxHistoryMessages - 1))
    .map((item) => `${item.role}: ${item.text}`)
    .join('\n');

  const instructions = [
    'You are a read-only source-code Q&A assistant.',
    `Knowledge label: ${config.knowledgeLabel}`,
    'Read code and answer questions based on the local repository.',
    'Do not modify files, create files, or run destructive commands.',
    'Always produce a direct textual answer for the user.',
    'Do not reveal local filesystem paths, usernames, hostnames, tokens, or environment details.',
    `If you need to refer to the repository, call it "${config.knowledgeLabel}".`,
    'If the answer is uncertain, say so clearly.',
  ].join('\n');

  return [
    instructions,
    historyText ? `Conversation history:\n${historyText}` : '',
    imagePaths.length ? `Attached images: ${imagePaths.map((_, index) => `image_${index + 1}`).join(', ')}` : '',
    `User question:\n${String(userText || '').trim()}`,
  ].filter(Boolean).join('\n\n');
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
