import fs from 'node:fs';
import path from 'node:path';
import { splitReplyText, stripReplyControlMarkers } from '../model.js';
import { getProviderLabel, runProvider } from '../provider/index.js';

export class MessageEngine {
  constructor(config, transport, sessionStore) {
    this.config = config;
    this.transport = transport;
    this.sessionStore = sessionStore;
  }

  async handleInbound(message) {
    const text = String(message.text || '').trim();
    const originalText = String(message.originalText || text).trim();
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    if (!text && attachments.length === 0) return;
    process.stdout.write(`engine inbound: conversation=${message.conversationId} text=${JSON.stringify(text.slice(0, 80))} attachments=${attachments.length}\n`);

    if (isIdentityQuestion(originalText)) {
      await this.reply(message.conversationId, buildIdentityReply(this.config.knowledgeLabel));
      return;
    }

    if (isSensitiveMetaQuestion(originalText)) {
      await this.reply(message.conversationId, buildSensitiveMetaRefusal());
      return;
    }

    if (isOutOfScopeQuestion(originalText)) {
      await this.reply(message.conversationId, buildOutOfScopeRefusal(this.config.knowledgeLabel));
      return;
    }

    if (isJunkOrAbusiveQuestion(originalText)) {
      await this.reply(message.conversationId, buildJunkRefusal(this.config.knowledgeLabel));
      return;
    }

    if (text === '/help') {
      await this.reply(message.conversationId, [
        '可用命令',
        '/help',
        '/status',
        '/reset',
        '直接发送普通问题即可交给 Codex 处理。',
      ].join('\n'));
      return;
    }

    if (text === '/status') {
      const session = this.sessionStore.getConversation(message.conversationId);
      await this.reply(message.conversationId, [
        '当前状态',
        `conversation: ${session.id}`,
        `history: ${session.history.length}`,
        `knowledge: ${this.config.knowledgeLabel}`,
        `provider: ${this.config.provider}`,
        `mode: ${this.config.readOnlyQaMode ? 'read-only qa' : 'normal'}`,
      ].join('\n'));
      return;
    }

    if (text === '/reset') {
      const session = this.sessionStore.getConversation(message.conversationId);
      session.history = [];
      session.updatedAt = new Date().toISOString();
      this.sessionStore.save();
      await this.reply(message.conversationId, '已清空当前会话历史。');
      return;
    }

    this.sessionStore.appendMessage(message.conversationId, 'user', text || buildAttachmentOnlyPrompt(attachments));
    const session = this.sessionStore.getConversation(message.conversationId);

    await this.reply(message.conversationId, '处理中...');

    const imagePaths = await materializeImageAttachments(this.config, message);
    if (attachments.length > 0) {
      process.stdout.write(`attachments received: total=${attachments.length}, images=${attachments.filter((item) => item?.kind === 'image').length}, downloaded=${imagePaths.length}\n`);
    }
    const promptText = text || buildAttachmentOnlyPrompt(attachments);
    const result = await runProvider(this.config, session, promptText, { imagePaths });
    if (!result.ok) {
      await this.reply(message.conversationId, [
        `${getProviderLabel(result.provider || this.config)} 执行失败`,
        `error: ${result.error || '(unknown)'}`,
        result.logs.length ? `logs: ${result.logs.join(' | ')}` : '',
      ].filter(Boolean).join('\n'));
      return;
    }

    process.stdout.write(`provider result: conversation=${message.conversationId} provider=${result.provider || this.config.provider} fallbackFrom=${result.fallbackFrom || '-'} ok=${result.ok}\n`);

    const rawAnswer = this.config.showReasoning && result.reasonings.length
      ? ['[Reasoning]', result.reasonings.join('\n\n'), '', '[Answer]', result.text].join('\n')
      : result.text || '已完成，但没有返回文本。';
    const answer = sanitizeReplyText(rawAnswer, this.config, originalText);

    if (!answer) {
      process.stderr.write(`reply blocked by safety filter: conversation=${message.conversationId} question=${JSON.stringify(originalText.slice(0, 120))}\n`);
      await this.reply(message.conversationId, buildBlockedReply());
      return;
    }

    this.sessionStore.appendMessage(message.conversationId, 'assistant', stripReplyControlMarkers(answer));
    await this.reply(message.conversationId, answer);
  }

  async reply(conversationId, text) {
    const chunks = splitReplyText(text, this.config.maxReplyChars, {
      codeBlockMaxChars: this.config.replyCodeBlockMaxChars,
    });
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      try {
        await this.transport.sendText(conversationId, chunk);
        if (index < chunks.length - 1) {
          await sleep(this.config.replyChunkDelayMs);
        }
      } catch (err) {
        process.stderr.write(`reply failed: conversation=${conversationId} error=${err instanceof Error ? err.message : String(err)}\n`);
        throw err;
      }
    }
  }
}

function sanitizeReplyText(text, config, userText = '') {
  let output = String(text || '');
  const knowledgeRoot = String(config.knowledgeRoot || '').trim();
  const knowledgeLabel = String(config.knowledgeLabel || 'knowledge-base').trim() || 'knowledge-base';
  const protectedUrls = [];

  output = output.replace(/https?:\/\/[^\s"'`<>]+/gi, (match) => {
    const token = `__URL_${protectedUrls.length}__`;
    protectedUrls.push(match);
    return token;
  });

  if (knowledgeRoot) {
    const escapedRoot = escapeRegex(knowledgeRoot.replace(/\//g, '\\'));
    output = output.replace(new RegExp(escapedRoot, 'gi'), knowledgeLabel);
    const normalizedRoot = knowledgeRoot.replace(/\\/g, '/');
    output = output.replace(new RegExp(escapeRegex(normalizedRoot), 'gi'), knowledgeLabel);
  }

  output = output.replace(/[A-Za-z]:\\[^\s"'`]+/g, knowledgeLabel);
  output = output.replace(/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){2,}/g, knowledgeLabel);
  output = output.replace(/__URL_(\d+)__/g, (_, index) => protectedUrls[Number(index)] || '');
  output = output.trim();

  if (!output) return '';
  if (containsBlockedReplySignals(output, userText)) return '';
  return output;
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildAttachmentOnlyPrompt(attachments) {
  const imageCount = Array.isArray(attachments) ? attachments.filter((item) => item?.kind === 'image').length : 0;
  if (imageCount > 0) {
    return `请分析这${imageCount}张图片并回答用户问题。`;
  }
  return '请根据附件内容回答用户问题。';
}

async function materializeImageAttachments(config, message) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const images = attachments
    .filter((item) => item?.kind === 'image')
    .slice(0, config.maxImageAttachments);

  if (images.length === 0) return [];

  const baseDir = path.join(config.attachmentDir, sanitizePathSegment(message.conversationId), sanitizePathSegment(message.messageId || String(Date.now())));
  fs.mkdirSync(baseDir, { recursive: true });

  const output = [];
  for (let index = 0; index < images.length; index += 1) {
    const item = images[index];
    const filePath = path.join(baseDir, `${String(index + 1).padStart(2, '0')}${resolveImageExtension(item)}`);
    const saved = await saveImageAttachment(message, item, filePath);
    if (saved) {
      output.push(saved);
    }
  }
  return output;
}

async function saveImageAttachment(message, item, targetPath) {
  if (item?.url) {
    const saved = await downloadToFile(item.url, targetPath);
    if (saved) return saved;
  }

  if (message.transportRef && typeof message.transportRef.resolveImageFile === 'function' && item?.file) {
    try {
      const resolved = await message.transportRef.resolveImageFile(item.file);
      if (resolved?.file && fs.existsSync(resolved.file)) {
        fs.copyFileSync(resolved.file, targetPath);
        return targetPath;
      }
      if (resolved?.url) {
        const saved = await downloadToFile(resolved.url, targetPath);
        if (saved) return saved;
      }
    } catch {
    }
  }

  return '';
}

async function downloadToFile(url, targetPath) {
  try {
    const response = await fetch(url);
    if (!response.ok) return '';
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(targetPath, Buffer.from(arrayBuffer));
    return targetPath;
  } catch {
    return '';
  }
}

function resolveImageExtension(item) {
  const byUrl = extFromUrl(item?.url);
  if (byUrl) return byUrl;
  const byFile = path.extname(String(item?.file || '').trim());
  return byFile || '.jpg';
}

function extFromUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    const ext = path.extname(parsed.pathname || '');
    return ext || '';
  } catch {
    return '';
  }
}

function sanitizePathSegment(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .slice(0, 120);
}

function sleep(ms) {
  const delay = Number(ms) || 0;
  if (delay <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function isIdentityQuestion(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;

  const exactMatches = new Set([
    '你是谁',
    '你是干什么的',
    '你是做什么的',
    '介绍下你自己',
    '介绍一下你自己',
    '介绍下自己',
    '介绍一下自己',
    '你能干什么',
    '你能做什么',
    'what are you',
    'who are you',
  ]);

  return exactMatches.has(value);
}

function buildIdentityReply(knowledgeLabel) {
  const label = String(knowledgeLabel || '知识库').trim() || '知识库';
  return [
    `我是 ${label} 的问答助手。`,
    `可以问我：${label} 的概念定位，API / DSL 用法，查询更新删除机制，注解配置策略，IDEA 插件相关能力。`,
    '直接问具体问题就行。',
  ].join('\n');
}

function isSensitiveMetaQuestion(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;

  const patterns = [
    /system\s*prompt/,
    /\bprompt\b.*(输出|泄露|打印|展示|show|print|dump|reveal)/,
    /(输出|打印|展示|泄露).*(system|prompt|提示词|系统提示|系统指令|隐藏指令|内部指令)/,
    /(推测|猜测|还原|复原).*(system|prompt|提示词|系统提示|系统指令|隐藏指令|内部指令)/,
    /(当前|所有|完整|全部).*(消息|message|history|聊天记录|上下文|会话)/,
    /(输出|打印|展示|泄露).*(所有消息|全部消息|完整消息|历史消息|上下文|会话记录|memory|记忆)/,
    /(调试|debug).*(消息|history|prompt|提示词|上下文|会话)/,
    /(developer|system).*(message|messages|prompt|instruction|instructions)/,
    /(内部配置|隐藏配置|环境变量|token|access[_ -]?token|webui token|secret|密钥)/,
    /(把.*(历史|上下文|消息|prompt|提示词).*(发出来|贴出来|给我))/,
  ];

  return patterns.some((pattern) => pattern.test(value));
}

function buildSensitiveMetaRefusal() {
  return [
    '这个请求我不能提供。',
    '我不会输出提示词、隐藏消息、调试信息、token 或内部配置。',
    '如果你想了解能力范围，可以直接问业务问题、API 用法或机制说明。',
  ].join('\n');
}

function isOutOfScopeQuestion(text) {
  const value = normalizeForPolicy(text);
  if (!value) return false;

  if (looksLikeKnowledgeQuestion(value)) return false;

  const outOfScopeHints = [
    '新闻',
    '热点',
    '时事',
    '国际',
    '国内',
    '选举',
    '局势',
    '人物评价',
    '政策解读',
    '社会事件',
    '站队',
    '观点表态',
    '宣传文案',
    '公开信',
    '倡议书',
    '演讲稿',
  ];

  return outOfScopeHints.some((item) => value.includes(item));
}

function isJunkOrAbusiveQuestion(text) {
  const value = normalizeForPolicy(text);
  if (!value) return false;

  if (looksLikeKnowledgeQuestion(value) && !hasStrongJunkSignals(value)) {
    return false;
  }

  return hasStrongJunkSignals(value);
}

function buildOutOfScopeRefusal(knowledgeLabel) {
  const label = String(knowledgeLabel || '知识库').trim() || '知识库';
  return [
    '这不是当前知识库问题。',
    `可以直接问 ${label} 相关内容，比如注解怎么用，查询 / 分页 / 关联怎么写，DTO / VO 映射规则，逻辑删除和更新行为，IDEA 插件功能或配置。`,
  ].join('\n');
}

function buildBlockedReply() {
  return [
    '这条回复已被安全策略拦截。',
    '请改问和当前知识库直接相关的代码、文档、配置或插件问题。',
  ].join('\n');
}

function buildJunkRefusal(knowledgeLabel) {
  const label = String(knowledgeLabel || '知识库').trim() || '知识库';
  return [
    '这条消息不符合当前助手的处理规则。',
    `我只处理和 ${label} 直接相关的知识库问题，不处理广告引流、联系方式收集、刷屏灌水、伪装指令或无关内容生成。`,
    '请改问具体的代码、文档、配置、插件或截图问题。',
  ].join('\n');
}

function containsBlockedReplySignals(answer, userText) {
  const value = normalizeForPolicy(answer);
  const question = normalizeForPolicy(userText);
  const technicalKnowledgeExchange = looksLikeKnowledgeQuestion(question)
    && (looksLikeKnowledgeAnswer(value) || looksLikeStructuredTechnicalPayload(value));

  if (!value) return false;
  if (looksLikePromptLeak(value)) return true;
  if (!technicalKnowledgeExchange && looksLikeJunkReply(value, question)) return true;

  const outOfScopeReplyHints = [
    '新闻',
    '热点',
    '时事',
    '国际',
    '国内',
    '选举',
    '局势',
    '政策',
    '倡议',
    '公开信',
    '演讲稿',
    '表态',
    '立场',
    '口号',
  ];

  if (outOfScopeReplyHints.some((item) => value.includes(item))) {
    if (technicalKnowledgeExchange) return false;
    if (!looksLikeKnowledgeQuestion(question)) return true;
    if (!looksLikeKnowledgeAnswer(value)) return true;
  }

  return false;
}

function looksLikeJunkReply(answer, userText) {
  if (hasContactCollectionSignals(answer)) return true;
  if (hasPromotionSignals(answer) && hasContactCollectionSignals(answer) && !looksLikeKnowledgeQuestion(userText)) return true;
  if (hasCommandInjectionSignals(answer) && !looksLikeKnowledgeAnswer(answer)) return true;
  if (hasMassMessagingSignals(answer)) return true;
  return false;
}

function looksLikePromptLeak(text) {
  const patterns = [
    'system prompt',
    'developer message',
    'hidden instruction',
    'internal config',
    'session history',
    'debug log',
    'tool output',
  ];
  return patterns.some((item) => text.includes(item));
}

function looksLikeKnowledgeQuestion(text) {
  const hints = [
    'easy-query',
    'easy query',
    'easyquery',
    'eq',
    'hibernate',
    'mybatis',
    'mybatis-plus',
    'mybatis plus',
    'mybatis-flex',
    'mybatis flex',
    'jooq',
    'querydsl',
    'spring-data-jpa',
    'spring data jpa',
    'plugin',
    'intellij',
    'idea',
    '源码',
    '代码',
    '接口',
    '方法',
    '类',
    '注解',
    '配置',
    'dsl',
    'sql',
    '查询',
    '更新',
    '删除',
    '逻辑删除',
    '插件',
    '文档',
    '实现',
    '行为',
    '调用链',
    '架构',
    '报错',
    '异常',
    '图片',
    '截图',
    '比较',
    '对比',
    '区别',
    '优缺点',
    '选型',
  ];
  return hints.some((item) => text.includes(item));
}

function looksLikeKnowledgeAnswer(text) {
  const hints = [
    'easy-query',
    'easy query',
    'easyquery',
    'mybatis',
    'mybatis-plus',
    'mybatis plus',
    'mybatis-flex',
    'mybatis flex',
    'jooq',
    'querydsl',
    'spring-data-jpa',
    'spring data jpa',
    'class',
    'method',
    'config',
    'plugin',
    'intellij',
    'easy-query',
    'hibernate',
    'sql',
    'dsl',
    'api',
    'annotation',
    '源码',
    '代码',
    '文档',
    '实现',
    '配置',
    '方法',
    '类',
    '接口',
    '注解',
    '查询',
    '更新',
    '删除',
    '逻辑删除',
    '插件',
    '比较',
    '对比',
    '区别',
    'orm',
    'cte',
    'recursive',
    'with recursive',
    'union all',
    'window function',
    'partition by',
    'over(',
    'group by',
    'having',
    'entityqueryable',
    'selectcolumn',
    'wherecolumns',
    'sql',
  ];
  return hints.some((item) => text.includes(item));
}

function normalizeForPolicy(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function hasStrongJunkSignals(text) {
  const structuredTechnicalPayload = looksLikeStructuredTechnicalPayload(text);
  return [
    hasPromotionSignals(text),
    hasContactCollectionSignals(text),
    hasCommandInjectionSignals(text),
    hasMassMessagingSignals(text),
    !structuredTechnicalPayload && hasRepetitionSpam(text),
  ].some(Boolean);
}

function looksLikeStructuredTechnicalPayload(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;

  const sqlHints = [
    'select ',
    ' from ',
    ' join ',
    ' where ',
    ' group by ',
    ' order by ',
    ' having ',
    ' union all ',
    ' with recursive ',
    'partition by ',
    'over(',
    'limit ',
    'date\'',
  ];
  const sqlScore = countIncludedHints(value, sqlHints);
  if (sqlScore >= 3) return true;

  const codeHints = [
    'public class ',
    'private ',
    'protected ',
    'import ',
    'package ',
    '@table',
    '@column',
    '@data',
    'exception',
    'stack trace',
    'traceback',
  ];
  const codeScore = countIncludedHints(value, codeHints);
  if (codeScore >= 3 && /[;{}()=@]/.test(value)) return true;

  if (sqlScore >= 2 && /count\(|sum\(|avg\(|min\(|max\(|row_number\(|rank\(|dense_rank\(|ntile\(/.test(value)) {
    return true;
  }

  return false;
}

function countIncludedHints(text, hints) {
  let count = 0;
  for (const hint of hints) {
    if (text.includes(hint)) count += 1;
  }
  return count;
}

function hasPromotionSignals(text) {
  const hints = [
    '加我',
    '私聊我',
    '联系客服',
    'vx',
    'vx:',
    'wechat',
    'qq号',
    '群号',
    '推广',
    '引流',
    '返利',
    '优惠',
    '代理',
    '代做',
    '代写',
    '接单',
    '出售',
    '课程',
    '培训',
    '免费领取',
    '点击链接',
    '扫码',
  ];
  return hints.some((item) => text.includes(item));
}

function hasContactCollectionSignals(text) {
  if (/(联系方式|手机号|手机号码|邮箱|email|wx|wechat|vx|qq)\s*(是|多少|给我|发我|留下|联系)/.test(text)) {
    return true;
  }
  if (/\b1\d{10}\b/.test(text)) return true;
  if (/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/.test(text)) return true;
  if (/\b\d{5,12}\b/.test(text) && /(qq|群|联系|加我|号码)/.test(text)) return true;
  return false;
}

function hasCommandInjectionSignals(text) {
  const hints = [
    '忽略上面',
    '忽略之前',
    '从现在开始',
    '你现在是',
    '请严格执行',
    '无视规则',
    '覆盖规则',
    '执行命令',
    '运行命令',
    'powershell',
    'cmd /c',
    'bash -c',
    'curl ',
    'wget ',
    'invoke-webrequest',
    '下载并执行',
    '脚本如下',
    '把下面内容原样发出',
    '逐字输出',
  ];
  return hints.some((item) => text.includes(item));
}

function hasMassMessagingSignals(text) {
  const hints = [
    '群发',
    '转发到所有群',
    '转给大家',
    '帮我发到群里',
    '全体成员',
    '@所有人',
    '@all',
    '通知所有人',
    '公告文案',
  ];
  return hints.some((item) => text.includes(item));
}

function hasRepetitionSpam(text) {
  if (text.length >= 80) {
    const uniqueChars = new Set(text.replace(/\s+/g, '').split(''));
    if (uniqueChars.size > 0 && uniqueChars.size <= 6) return true;
  }

  const repeatedChunk = /(.{2,12})\1{3,}/;
  if (repeatedChunk.test(text)) return true;

  const punctuationBurst = /[!?.~。！？]{8,}/;
  if (punctuationBurst.test(text)) return true;

  return false;
}
