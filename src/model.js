export const QQ_SPLIT_MARKER = '[[QQ_SPLIT]]';
const QQ_BLOCK_PATTERN = /^\[\[QQ_BLOCK:(body|code|list|followup)\]\]\s*(.*)$/i;

export function createInboundMessage(input = {}) {
  const text = String(input.text || '');
  return {
    transport: String(input.transport || '').trim() || 'unknown',
    conversationId: String(input.conversationId || '').trim(),
    senderId: String(input.senderId || '').trim(),
    chatType: String(input.chatType || '').trim() || 'private',
    messageId: String(input.messageId || '').trim(),
    text,
    originalText: typeof input.originalText === 'string' ? input.originalText : text,
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

export function splitReplyText(text, limit = 1500, options = {}) {
  const value = normalizeReplyTextForQQ(text);
  const softLimit = Math.min(limit, 220);
  const requestedCodeLimit = Number(options.codeBlockMaxChars) || 3000;
  const codeSoftLimit = Math.max(softLimit, requestedCodeLimit);
  const groupedSoftLimit = Math.min(limit, 420);
  if (!value) return [''];
  const structuredChunks = splitByStructuredBlocks(value, {
    softLimit,
    codeSoftLimit,
    groupedSoftLimit,
    hardLimit: limit,
  });
  if (structuredChunks.length > 0) return structuredChunks;
  const markedChunks = splitByAiMarker(value, { softLimit, codeSoftLimit, hardLimit: limit });
  if (markedChunks.length > 1) return markedChunks;
  if (value.length <= softLimit) return [value];

  const segments = buildSemanticSegments(value, limit);
  return packSegmentsIntoChunks(segments, { softLimit, codeSoftLimit, groupedSoftLimit, hardLimit: limit });
}

export function stripReplyControlMarkers(text) {
  return String(text || '')
    .replace(/^\s*\[\[QQ_BLOCK:(body|code|list|followup)\]\]\s*/gim, '')
    .replace(new RegExp(`\\s*${escapeRegex(QQ_SPLIT_MARKER)}\\s*`, 'g'), '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeReplyTextForQQ(text) {
  return String(text || '')
    .replace(/^\s*\[\[QQ_BLOCK:(body|code|list|followup)\]\]\s*/gim, (full) => `${full.trim()}\n`)
    .replace(new RegExp(`\\s*${escapeRegex(QQ_SPLIT_MARKER)}\\s*`, 'g'), `\n${QQ_SPLIT_MARKER}\n`)
    .replace(/```[^\n]*\n?/g, '')
    .replace(/```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '- ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitByStructuredBlocks(text, limits) {
  const lines = String(text || '').split('\n');
  const blocks = [];
  let current = null;
  let fallback = [];
  let sawMarker = false;

  const flushCurrent = () => {
    if (!current) return;
    const content = current.lines.join('\n').trim();
    if (content) {
      blocks.push({ type: current.type, content });
    }
    current = null;
  };

  for (const rawLine of lines) {
    const line = String(rawLine || '');
    const match = line.trim().match(QQ_BLOCK_PATTERN);
    if (match) {
      sawMarker = true;
      flushCurrent();
      if (fallback.length > 0) {
        const fallbackContent = fallback.join('\n').trim();
        if (fallbackContent) blocks.push({ type: 'body', content: fallbackContent });
        fallback = [];
      }

      current = {
        type: String(match[1] || 'body').toLowerCase(),
        lines: [],
      };

      const inline = String(match[2] || '').trim();
      if (inline) current.lines.push(inline);
      continue;
    }

    if (current) {
      current.lines.push(line);
    } else {
      fallback.push(line);
    }
  }

  flushCurrent();
  if (!sawMarker) return [];
  if (fallback.length > 0) {
    const fallbackContent = fallback.join('\n').trim();
    if (fallbackContent) blocks.push({ type: 'body', content: fallbackContent });
  }

  return mergeStructuredBlocks(blocks, limits).flatMap((block) => renderStructuredBlock(block, limits));
}

function mergeStructuredBlocks(blocks, limits) {
  const items = Array.isArray(blocks) ? blocks : [];
  if (items.length <= 1) return items;

  const merged = [];
  for (const block of items) {
    const current = normalizeStructuredBlock(block);
    if (!current) continue;

    const previous = merged[merged.length - 1];
    if (shouldMergeStructuredBlocks(previous, current, limits)) {
      previous.content = `${previous.content}\n\n${current.content}`.trim();
      previous.type = current.type;
      continue;
    }

    merged.push(current);
  }

  return merged;
}

function normalizeStructuredBlock(block) {
  const type = String(block?.type || '').trim().toLowerCase();
  const content = String(block?.content || '').trim();
  if (!content) return null;
  if (!['body', 'code', 'list', 'followup'].includes(type)) {
    return { type: 'body', content };
  }
  return { type, content };
}

function shouldMergeStructuredBlocks(previous, current, limits) {
  if (!previous || !current) return false;
  if (previous.type !== 'body') return false;
  if (!['list', 'followup'].includes(current.type)) return false;
  if (!isListIntro(previous.content)) return false;

  const combined = `${previous.content}\n\n${current.content}`.trim();
  return combined.length <= limits.groupedSoftLimit;
}

function splitByAiMarker(text, limits) {
  if (!String(text || '').includes(QQ_SPLIT_MARKER)) return [];

  const parts = String(text || '')
    .split(QQ_SPLIT_MARKER)
    .map((item) => item.trim())
    .filter(Boolean);

  if (parts.length <= 1) return [];

  const segments = parts.flatMap((item) => {
    const segmentLimit = isCodeLikeSegment(item) ? limits.codeSoftLimit : limits.hardLimit;
    if (item.length <= segmentLimit) return [item];
    return splitLongSegment(item, segmentLimit);
  });

  return packSegmentsIntoChunks(segments, limits);
}

function renderStructuredBlock(block, limits) {
  const type = String(block?.type || 'body').trim().toLowerCase();
  const content = String(block?.content || '').trim();
  if (!content) return [];

  if (type === 'code') {
    return splitCodeBlock(content, limits);
  }

  const softLimit = type === 'list' || type === 'followup'
    ? limits.groupedSoftLimit
    : limits.softLimit;
  const segments = type === 'list' || type === 'followup'
    ? buildListSegments(content, limits.hardLimit)
    : buildSemanticSegments(content, limits.hardLimit);

  return packSegmentsIntoChunks(
    segments,
    limits,
    { respectHeadings: type === 'body' },
  );
}

function buildSemanticSegments(text, limit) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);

  const segments = [];
  for (const paragraph of paragraphs) {
    const lines = paragraph
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean);

    let codeBuffer = [];
    const flushCodeBuffer = () => {
      if (codeBuffer.length === 0) return;
      const codeBlock = codeBuffer.join('\n').trim();
      if (codeBlock) segments.push(codeBlock);
      codeBuffer = [];
    };

    for (const line of lines) {
      if (isCodeLikeLine(line)) {
        codeBuffer.push(line);
        continue;
      }

      flushCodeBuffer();

      if (line.length <= limit) {
        segments.push(line);
        continue;
      }

      const sentences = splitLongSegment(line, limit);
      for (const sentence of sentences) {
        if (sentence) segments.push(sentence);
      }
    }

    flushCodeBuffer();
  }

  return segments;
}

function splitLongSegment(text, limit) {
  const sentenceParts = String(text || '')
    .split(/(?<=[。！？!?；;])/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (sentenceParts.length <= 1) {
    return hardSplitSegment(text, limit);
  }

  const output = [];
  let current = '';
  for (const part of sentenceParts) {
    if (!current) {
      current = part;
      continue;
    }

    const candidate = `${current}${part}`;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    output.push(current.trim());
    current = part;
  }

  if (current) output.push(current.trim());
  return output.flatMap((item) => item.length > limit ? hardSplitSegment(item, limit) : [item]);
}

function hardSplitSegment(text, limit) {
  const output = [];
  let rest = String(text || '').trim();

  while (rest.length > limit) {
    let splitAt = rest.lastIndexOf('，', limit);
    if (splitAt < Math.floor(limit * 0.5)) splitAt = rest.lastIndexOf('：', limit);
    if (splitAt < Math.floor(limit * 0.5)) splitAt = rest.lastIndexOf(' ', limit);
    if (splitAt < Math.floor(limit * 0.5)) splitAt = limit;
    output.push(rest.slice(0, splitAt + (splitAt === limit ? 0 : 1)).trim());
    rest = rest.slice(splitAt + (splitAt === limit ? 0 : 1)).trim();
  }

  if (rest) output.push(rest);
  return output;
}

function splitCodeBlock(text, limits) {
  const value = String(text || '').trim();
  if (!value) return [];
  if (value.length <= limits.codeSoftLimit) return [value];

  const lines = value.split('\n');
  const chunks = [];
  let current = '';

  for (const rawLine of lines) {
    const line = String(rawLine || '');
    if (!current) {
      current = line;
      continue;
    }

    const candidate = `${current}\n${line}`;
    if (candidate.length <= limits.codeSoftLimit) {
      current = candidate;
      continue;
    }

    chunks.push(current.trim());
    current = line;
  }

  if (current) chunks.push(current.trim());
  return chunks.flatMap((item) => item.length > limits.hardLimit ? hardSplitSegment(item, limits.hardLimit) : [item]);
}

function buildListSegments(text, limit) {
  const paragraphs = String(text || '')
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (paragraphs.length > 1) {
    return paragraphs.flatMap((item) => item.length > limit ? splitLongSegment(item, limit) : [item]);
  }

  const lines = String(text || '')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);

  const segments = [];
  let current = '';

  for (const line of lines) {
    if (!current) {
      current = line;
      continue;
    }

    if (isListItem(line) && !isListItem(current)) {
      segments.push(current.trim());
      current = line;
      continue;
    }

    const joiner = isCodeLikeLine(current) || isCodeLikeLine(line) ? '\n' : '\n';
    current = `${current}${joiner}${line}`.trim();
  }

  if (current) segments.push(current.trim());
  return segments.flatMap((item) => item.length > limit ? splitLongSegment(item, limit) : [item]);
}

function packSegmentsIntoChunks(segments, limits, options = {}) {
  const chunks = [];
  let current = '';
  const respectHeadings = options.respectHeadings !== false;

  for (const rawSegment of segments) {
    const segment = String(rawSegment || '').trim();
    if (!segment) continue;

    if (!current) {
      current = segment;
      continue;
    }

    const candidate = `${current}\n\n${segment}`;
    const chunkLimit = resolveChunkLimit(current, segment, limits);
    if (
      respectHeadings
      && shouldStartNewChunk(segment)
      && !shouldKeepWithPrevious(current, segment, candidate, chunkLimit)
    ) {
      chunks.push(current.trim());
      current = segment;
      continue;
    }

    if (candidate.length <= chunkLimit) {
      current = candidate;
      continue;
    }

    chunks.push(current.trim());
    current = segment;
  }

  if (current) chunks.push(current.trim());
  return chunks;
}

function resolveChunkLimit(current, next, limits) {
  const hasCode = isCodeLikeSegment(current) || isCodeLikeSegment(next);
  return hasCode ? limits.codeSoftLimit : limits.softLimit;
}

function shouldKeepWithPrevious(current, segment, candidate, chunkLimit) {
  if (candidate.length > chunkLimit) return false;
  if (!isListItem(segment)) return false;

  const currentValue = String(current || '').trim();
  if (!currentValue) return false;

  if (isListIntro(currentValue)) return true;
  if (isShortListBlock(currentValue)) return true;

  return false;
}

function shouldStartNewChunk(segment) {
  const value = String(segment || '').trim();
  if (!value) return false;
  if (value.length > 40) return false;

  const headingPatterns = [
    /^\d+[.、．]\s*\S+/,
    /^[（(]\d+[)）]\s*\S+/,
    /^[一二三四五六七八九十]+[.、]\s*\S+/,
    /^(优点|缺点|总结|结论|建议|原因|区别|场景|定位|实现|用法|注意点|补充)[:：]?\s*$/,
  ];

  if (!headingPatterns.some((pattern) => pattern.test(value))) {
    return false;
  }

  return !/[。！？!?；;]$/.test(value);
}

function isListItem(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return [
    /^\d+[.、．]\s+\S+/,
    /^[（(]\d+[)）]\s+\S+/,
    /^[-*+]\s+\S+/,
  ].some((pattern) => pattern.test(text));
}

function isListIntro(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (text.includes('\n')) {
    const lines = text.split('\n').map((item) => item.trim()).filter(Boolean);
    const lastLine = lines[lines.length - 1] || '';
    return /[:：]$/.test(lastLine) && lines.every((line, index) => index === lines.length - 1 || !isListItem(line));
  }
  return /[:：]$/.test(text);
}

function isShortListBlock(value) {
  const lines = String(value || '')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);

  if (lines.length < 2) return false;
  const listLines = lines.filter((line) => isListItem(line));
  if (listLines.length === 0) return false;

  const nonListLines = lines.filter((line) => !isListItem(line));
  if (nonListLines.length > 1) return false;
  if (nonListLines.length === 1 && !/[:：]$/.test(nonListLines[0])) return false;

  return lines.join('\n').length <= 220;
}

function isCodeLikeSegment(segment) {
  const lines = String(segment || '')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);

  if (lines.length === 0) return false;
  if (lines.length >= 2 && lines.every(isCodeLikeLine)) return true;
  return lines.some((line) => isCodeLikeLine(line) && /[;{}()=@]/.test(line));
}

function isCodeLikeLine(line) {
  const value = String(line || '').trim();
  if (!value) return false;

  if (/^(@[A-Za-z_]\w*(\([^)]*\))?|package\s+|import\s+|public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|class\s+|interface\s+|enum\s+|record\s+|return\b|new\s+|if\s*\(|for\s*\(|while\s*\(|switch\s*\(|case\b|try\b|catch\s*\(|finally\b)/.test(value)) {
    return true;
  }

  if (/^[{}]+$/.test(value)) return true;
  if (/^\w[\w<>\[\], ?]*\s+\w+\s*(=\s*[^;]+)?;$/.test(value)) return true;
  if (/[;{}]/.test(value) && /[A-Za-z_]/.test(value)) return true;
  if (value.includes('->') || value.includes('::')) return true;

  return false;
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
