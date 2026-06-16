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
  const spawnEnv = buildCodexEnv(process.env, spawnCommand);

  return await new Promise((resolve) => {
    const child = spawn(spawnCommand.command, spawnCommand.args, {
      cwd: config.knowledgeRoot,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end();

    let stdoutBuf = '';
    let stderrBuf = '';
    let threadId = null;
    let lastAgentMessage = '';
    const reasonings = [];
    const logs = [];
    let quotaExhausted = false;
    let reasoningCount = 0;
    let messageCount = 0;
    let settled = false;

    const emitProgress = (event) => {
      if (!onProgress || !event || typeof event !== 'object') return;
      onProgress(event);
    };

    const finalize = (payload, terminateChild = false) => {
      if (settled) return;
      settled = true;
      resolve(payload);
      if (terminateChild) {
        terminateSpawnedProcess(child);
      }
    };

    const trackProviderSignal = (value) => {
      if (looksLikeQuotaExhausted(value)) {
        quotaExhausted = true;
        emitProgress({ stage: 'failed', reason: 'quota_exhausted' });
      }
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
          if (ev.type === 'turn.failed') {
            const errorText = typeof ev.error?.message === 'string'
              ? ev.error.message
              : typeof ev.message === 'string'
                ? ev.message
                : JSON.stringify(ev.error || ev);
            trackProviderSignal(errorText);
            logs.push(errorText);
            emitProgress({ stage: 'failed', reason: quotaExhausted ? 'quota_exhausted' : '' });
            finalize({
              ok: false,
              error: quotaExhausted ? 'quota_exhausted' : errorText,
              text: '',
              reasonings,
              logs: quotaExhausted ? [...logs, 'quota_exhausted'] : logs,
              threadId,
            }, true);
            return;
          }
          if (ev.type === 'turn.completed') {
            const text = sanitizeFinalAnswer(lastAgentMessage);
            emitProgress({ stage: 'completed', threadId, messageCount, reasoningCount });
            finalize({
              ok: true,
              error: '',
              text,
              reasonings,
              logs,
              threadId,
            }, true);
            return;
          }
          if (ev.type === 'item.completed') {
            if (ev.item?.type === 'agent_message') {
              const text = extractAgentMessageText(ev.item);
              if (text) {
                trackProviderSignal(text);
                lastAgentMessage = text;
                messageCount += 1;
                emitProgress({ stage: 'thinking', messageCount });
              }
              return;
            }
            if (ev.item?.type === 'reasoning') {
              const reasoning = extractReasoningText(ev.item);
              if (reasoning) {
                trackProviderSignal(reasoning);
                reasonings.push(reasoning);
                reasoningCount += 1;
                emitProgress({ stage: 'thinking', reasoningCount });
              }
              return;
            }
          }
          if (ev.type === 'error') {
            const errorText = [
              typeof ev.message === 'string' ? ev.message : '',
              typeof ev.error === 'string' ? ev.error : '',
              ev.error && typeof ev.error === 'object' && typeof ev.error.message === 'string' ? ev.error.message : '',
            ].filter(Boolean).join(' | ') || JSON.stringify(ev.error || ev);
            trackProviderSignal(errorText);
            logs.push(errorText);
            emitProgress({ stage: 'failed' });
            return;
          }
          return;
        } catch {
          // keep falling through for non-json diagnostic lines
        }
      }

      if (source === 'stderr') {
        trackProviderSignal(trimmed);
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
      finalize({
        ok: false,
        error: quotaExhausted ? 'quota_exhausted' : err.message,
        text: '',
        reasonings,
        logs: [...logs, err.message],
        threadId,
      });
    });

    child.on('close', (exitCode, signal) => {
      if (settled) return;
      if (stdoutBuf.trim()) handleLine(stdoutBuf, 'stdout');
      if (stderrBuf.trim()) handleLine(stderrBuf, 'stderr');

      if (settled) return;
      const ok = exitCode === 0;
      const text = sanitizeFinalAnswer(lastAgentMessage);
      emitProgress({ stage: ok ? 'completed' : 'failed', threadId, messageCount, reasoningCount });

      finalize({
        ok,
        error: ok ? '' : quotaExhausted ? 'quota_exhausted' : `exit=${exitCode}${signal ? ` signal=${signal}` : ''}`,
        text,
        reasonings,
        logs: quotaExhausted ? [...logs, 'quota_exhausted'] : logs,
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
  if (process.platform !== 'win32') {
    return { command, args };
  }

  const directResolution = resolveCodexNodeWrapper(command, args);
  if (directResolution) return directResolution;

  const resolvedCommandPath = resolveWindowsCommandPath(command);
  const pathResolution = resolvedCommandPath ? resolveCodexNodeWrapper(resolvedCommandPath, args) : null;
  if (pathResolution) return pathResolution;

  return { command, args };
}

function resolveCodexNodeWrapper(command, args) {
  const raw = stripWrappingQuotes(command);
  if (!raw) return null;

  const lower = raw.replace(/\\/g, '/').toLowerCase();
  if (lower.endsWith('/node.exe') || lower.endsWith('node.exe')) {
    const codexScript = path.join(path.dirname(raw), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(codexScript)) {
      return { command: raw, args: [codexScript, ...args] };
    }
    return null;
  }

  const siblingNode = path.join(path.dirname(raw), 'node.exe');
  const codexScript = path.join(path.dirname(raw), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (fs.existsSync(siblingNode) && fs.existsSync(codexScript)) {
    return { command: siblingNode, args: [codexScript, ...args] };
  }

  return null;
}

function resolveWindowsCommandPath(command) {
  const raw = stripWrappingQuotes(command);
  if (!raw) return '';

  const hasPathSeparator = raw.includes('/') || raw.includes('\\');
  const pathEntries = hasPathSeparator || path.isAbsolute(raw)
    ? ['']
    : String(process.env.PATH || '')
      .split(path.delimiter)
      .map((entry) => stripWrappingQuotes(entry))
      .filter(Boolean);

  for (const entry of pathEntries) {
    const basePath = entry ? path.join(entry, raw) : raw;
    for (const candidate of buildWindowsCommandCandidates(basePath)) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return '';
}

function buildWindowsCommandCandidates(basePath) {
  const normalizedBasePath = stripWrappingQuotes(basePath);
  if (!normalizedBasePath) return [];
  if (path.extname(normalizedBasePath)) {
    return [normalizedBasePath];
  }

  const pathExts = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.PS1')
    .split(';')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  return [
    normalizedBasePath,
    ...pathExts.map((ext) => `${normalizedBasePath}${ext}`),
  ];
}

function stripWrappingQuotes(value) {
  return String(value || '').trim().replace(/^"(.*)"$/, '$1');
}

function buildCodexEnv(baseEnv, spawnCommand) {
  const env = { ...baseEnv };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const currentPath = String(env[pathKey] || '');
  const extraEntries = resolveCodexPathEntries(spawnCommand);
  if (extraEntries.length === 0) {
    return env;
  }

  const deduped = dedupePathEntries([...extraEntries, ...currentPath.split(path.delimiter)]);
  env[pathKey] = deduped.join(path.delimiter);
  return env;
}

function resolveCodexPathEntries(spawnCommand) {
  if (process.platform !== 'win32') return [];

  const entries = [];
  const commandPath = stripWrappingQuotes(spawnCommand?.command || '');
  const scriptPath = Array.isArray(spawnCommand?.args) ? stripWrappingQuotes(spawnCommand.args[0] || '') : '';

  if (commandPath) {
    const bundledRgDirFromNode = path.join(
      path.dirname(commandPath),
      'node_modules',
      '@openai',
      'codex',
      'node_modules',
      '@openai',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'codex-path',
    );
    if (fs.existsSync(path.join(bundledRgDirFromNode, 'rg.exe'))) {
      entries.push(bundledRgDirFromNode);
    }
  }

  if (scriptPath) {
    const bundledRgDirFromScript = path.resolve(
      path.dirname(scriptPath),
      '..',
      'node_modules',
      '@openai',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'codex-path',
    );
    if (fs.existsSync(path.join(bundledRgDirFromScript, 'rg.exe'))) {
      entries.push(bundledRgDirFromScript);
    }
  }

  return dedupePathEntries(entries);
}

function dedupePathEntries(entries) {
  const seen = new Set();
  const output = [];

  for (const entry of Array.isArray(entries) ? entries : []) {
    const value = String(entry || '').trim();
    if (!value) continue;
    const key = process.platform === 'win32' ? value.toLowerCase() : value;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }

  return output;
}

function terminateSpawnedProcess(child) {
  if (!child || typeof child !== 'object') return;
  if (child.exitCode != null) return;

  if (process.platform === 'win32') {
    const pid = Number(child.pid);
    if (!Number.isFinite(pid) || pid <= 0) return;
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => {});
    return;
  }

  try {
    child.kill('SIGTERM');
  } catch {
  }
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

function looksLikeQuotaExhausted(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return false;
  return [
    'user quota is not enough',
    'quota is not enough',
    'insufficient balance',
    'balance is not enough',
  ].some((item) => text.includes(item));
}

