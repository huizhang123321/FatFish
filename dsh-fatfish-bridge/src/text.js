/**
 * dsh-fatfish-bridge: 文本处理
 *
 * FatFish 的消息正文是**纯文本**（客户端按原样显示，只把贴纸 token 渲染成图片），
 * 而 DSH 的回复是 Markdown。这里做三件事：
 *   1. 把 Markdown 压平成聊天里读得懂的纯文本；
 *   2. 按段落/换行把超长回复拆成多条消息；
 *   3. 处理 @机器人、附件链接与列表展示用的小工具。
 *
 * 所有函数都是纯函数，便于单测。
 */

/**
 * 把 Markdown 压平成 FatFish 里可读的纯文本。
 *
 * 目标不是“完整 Markdown 渲染”，而是去掉在纯文本里只会变成噪声的记号：
 * 标题井号、加粗/斜体星号、行内反引号、代码围栏、引用箭头、图片/链接语法。
 * 代码块内容原样保留（缩进和换行是代码的一部分）。
 *
 * @param {string} markdown
 * @returns {string}
 */
export function markdownToPlainText(markdown) {
  let text = String(markdown ?? '').replace(/\r\n?/g, '\n')
  if (!text.trim()) return ''

  // 代码围栏：去掉 ```lang / ``` 行，保留代码本体。
  text = text.replace(/^[ \t]*```[^\n]*$/gm, '')

  // 图片 ![alt](url) → alt (url)；链接 [text](url) → text (url)。
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt, url) =>
    alt ? `${alt} (${url})` : url,
  )
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '$1 ($2)')

  // 标题：去掉行首 #。
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')

  // 引用：去掉行首 >。
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, '')

  // 加粗/斜体/删除线/行内代码：只去记号，保留内容。
  text = text.replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1')
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
  text = text.replace(/__([^_\n]+)__/g, '$1')
  text = text.replace(/~~([^~\n]+)~~/g, '$1')
  text = text.replace(/`([^`\n]+)`/g, '$1')

  // 水平分割线：留一条视觉分隔。
  text = text.replace(/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '────────')

  // 连续 3 个以上空行压成 2 个，避免聊天里出现大段空白。
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

/**
 * 判断某个位置是否落在未闭合的代码围栏内。
 *
 * @param {string} text
 * @param {number} index
 */
function insideCodeFence(text, index) {
  const before = text.slice(0, index)
  const fences = before.match(/^[ \t]*```/gm)
  return (fences?.length ?? 0) % 2 === 1
}

/**
 * 按上限拆分消息，优先在段落、其次在换行处断开，并避免把代码围栏劈成两半。
 *
 * @param {string} text
 * @param {number} limit 单条消息最大字符数。
 * @returns {string[]} 至少一条（输入为空时返回空数组）。
 */
export function splitMessage(text, limit) {
  const clean = String(text ?? '').trim()
  if (!clean) return []
  const max = Math.max(1, Math.round(Number(limit) || 4000))
  if (clean.length <= max) return [clean]

  const chunks = []
  let rest = clean
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max)
    if (cut < Math.floor(max * 0.5)) cut = rest.lastIndexOf('\n', max)
    if (cut < Math.floor(max * 0.5)) cut = max

    if (insideCodeFence(rest, cut)) {
      const lastFence = rest.lastIndexOf('```', cut)
      if (lastFence > Math.floor(max * 0.2)) cut = lastFence
    }

    const piece = rest.slice(0, cut).trim()
    if (piece) chunks.push(piece)
    rest = rest.slice(cut).trim()
  }
  if (rest) chunks.push(rest)
  return chunks
}

/** 去掉 @机器人 的提及（大小写不敏感，允许前后有空格/标点/中文紧邻）。 */
export function stripMention(text, botUsername) {
  const name = String(botUsername ?? '').trim()
  if (!name) return String(text ?? '')
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return String(text ?? '')
    .replace(new RegExp(`@${escaped}(?=[\\s,，:：]|$|[\\u4e00-\\u9fff])`, 'gi'), '')
    .replace(/^[\s,，:：]+/, '')
    .trim()
}

/** 消息是否 @ 了机器人。 */
export function mentionsBot(text, botUsername) {
  const name = String(botUsername ?? '').trim()
  if (!name) return false
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`@${escaped}(?=[\\s,，:：]|$|[\\u4e00-\\u9fff])`, 'i').test(String(text ?? ''))
}

/** 是否为斜杠命令（兼容全角斜杠）。 */
export function isSlashCommand(text) {
  const trimmed = String(text ?? '').trim()
  return trimmed.startsWith('/') || trimmed.startsWith('／')
}

/**
 * 解析斜杠命令。
 *
 * @param {string} raw
 * @returns {{ name: string, args: string } | undefined}
 */
export function parseCommand(raw) {
  if (!isSlashCommand(raw)) return undefined
  const trimmed = String(raw).trim().replace(/^／/, '/')
  const match = /^\/([^\s]*)(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (!match) return undefined
  return {
    name: (match[1] ?? '').toLowerCase(),
    args: (match[2] ?? '').trim(),
  }
}

/** 按最大长度截断，超出时补省略号。 */
export function truncate(text, max) {
  const value = String(text ?? '')
  const limit = Math.max(1, Math.round(Number(max) || 0))
  if (!limit || value.length <= limit) return value
  if (limit === 1) return '…'
  return `${value.slice(0, limit - 1)}…`
}

/** Token 数量的紧凑格式：1234 → 1.2K，1234567 → 1.2M。 */
export function formatTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0'
  const scaled = (candidate) =>
    candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)
  if (value < 1e3) return String(Math.round(value))
  if (value < 1e6) return `${scaled(value / 1e3)}K`
  return `${scaled(value / 1e6)}M`
}

/** `/状态` 里用的短会话 id：`session-abcd…`。 */
export function shortSessionId(sessionId) {
  const value = String(sessionId ?? '')
  const rest = value.startsWith('session-') ? value.slice('session-'.length) : value
  if (rest.length <= 4) return value
  return value.startsWith('session-') ? `session-${rest.slice(0, 4)}…` : `${rest.slice(0, 6)}…`
}

/**
 * WebUI 同款的相对时间文案：刚刚 / N分钟 / N小时 / N天 / N个月 / N年。
 *
 * @param {number} ms 毫秒时间戳。
 * @param {number} [now]
 * @returns {string | undefined} 时间缺失时返回 undefined（调用方省略该片段）。
 */
export function formatRelativeTime(ms, now = Date.now()) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined
  const minute = 60_000
  const hour = 3_600_000
  const day = 86_400_000
  const diff = Math.max(0, now - ms)
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)}分钟`
  if (diff < day) return `${Math.floor(diff / hour)}小时`
  if (diff < 30 * day) return `${Math.floor(diff / day)}天`
  if (diff < 365 * day) return `${Math.floor(diff / (30 * day))}个月`
  return `${Math.floor(diff / (365 * day))}年`
}

/**
 * 构造发给 DSH 会话的用户正文。
 *
 * - 私聊：保持原话，不加前缀；
 * - 频道/群组：加 `[发送者]` 前缀，因为同一个会话可能由多人轮流说话；
 * - 附件：追加绝对 URL，Agent 需要时可用 bash/read 工具取回。
 *
 * @param {{ sender: string, text: string, files?: string[], baseUrl: string, direct: boolean }} input
 * @returns {string}
 */
export function buildPrompt(input) {
  const body = String(input.text ?? '').trim()
  const files = Array.isArray(input.files) ? input.files.filter(Boolean) : []
  const lines = []
  if (body) {
    lines.push(input.direct ? body : `[${input.sender}] ${body}`)
  }
  for (const filename of files) {
    lines.push(`[附件] ${fileUrl(input.baseUrl, filename)}`)
  }
  return lines.join('\n').trim()
}

/** 上传文件的绝对 URL（与 Web 客户端同样的编码方式）。 */
export function fileUrl(baseUrl, filename) {
  return `${String(baseUrl).replace(/\/+$/, '')}/files/${encodeURIComponent(String(filename))}`
}

/** 安全地把任意值变成单行字符串（日志/回执用）。 */
export function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error ?? '')
}
