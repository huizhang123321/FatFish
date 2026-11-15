/**
 * dsh-fatfish-bridge: FatFish HTTP 客户端
 *
 * FatFish 是一个本地 Flask 服务：
 *   - 登录/注册是 **表单 + 会话 Cookie + CSRF**；
 *   - 消息读取是 `GET /messages/<channel>?after=<ts>`；
 *   - 发消息是 `POST /send/<channel>`（form：text / reply_to_id）。
 *
 * 本模块只做这三件事，不含任何 DSH 概念。它刻意不引入 HTTP 依赖：
 * Node ≥ 20 内置 fetch，Cookie 由下面这个很小的 jar 维护。
 */

/** 客户端错误：带 HTTP 状态码与服务端正文，便于日志与回执。 */
export class FatFishError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'FatFishError'
    this.status = options.status
    this.code = options.code
    this.body = options.body
  }
}

/** 一个只存在于内存里的 Cookie 罐子。 */
export class CookieJar {
  constructor() {
    /** @type {Map<string, string>} */
    this.cookies = new Map()
  }

  /** 吸收响应里的 Set-Cookie。 */
  absorb(response) {
    let lines = []
    const headers = response?.headers
    if (headers && typeof headers.getSetCookie === 'function') {
      lines = headers.getSetCookie()
    } else if (headers) {
      const raw = headers.get('set-cookie')
      if (raw) lines = [raw]
    }
    for (const line of lines) {
      const pair = String(line).split(';', 1)[0]
      const index = pair.indexOf('=')
      if (index <= 0) continue
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      if (!name) continue
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(String(line))) {
        this.cookies.delete(name)
      } else {
        this.cookies.set(name, value)
      }
    }
  }

  /** 生成 Cookie 请求头；没有 Cookie 时返回空字符串。 */
  header() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  clear() {
    this.cookies.clear()
  }
}

/** 从 HTML 错误页里抠出人类可读的错误文案。 */
function extractHtmlError(html) {
  const match = /<div class="auth-error">([\s\S]*?)<\/div>/i.exec(String(html ?? ''))
  const raw = match ? match[1] : ''
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** 读取响应正文（最多 500 字符），用于错误信息。 */
async function readBodySnippet(response) {
  try {
    const text = await response.text()
    return text.slice(0, 500)
  } catch {
    return ''
  }
}

export class FatFishClient {
  /**
   * @param {{
   *   baseUrl: string,
   *   username: string,
   *   password: string,
   *   logger?: { info: Function, warn: Function, error: Function, debug?: Function },
   *   fetchImpl?: typeof fetch,
   *   timeoutMs?: number,
   * }} options
   */
  constructor(options) {
    this.baseUrl = String(options.baseUrl ?? '').replace(/\/+$/, '')
    this.username = String(options.username ?? '')
    this.password = String(options.password ?? '')
    this.logger = options.logger
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs) || 15000)
    this.jar = new CookieJar()
    /** 服务端返回的规范用户名（大小写可能和配置不同）。 */
    this.user = undefined
    this.csrfToken = undefined
    this.loginPromise = undefined
    this.loggedInAt = 0
    if (!this.baseUrl) throw new FatFishError('FatFish 地址为空')
    if (!this.username) throw new FatFishError('FatFish 用户名为空')
  }

  /** 仅做一次底层请求：带 Cookie、手动处理重定向、超时。 */
  async #fetch(path, options = {}) {
    const url = `${this.baseUrl}${path}`
    const headers = new Headers(options.headers ?? {})
    headers.set('accept', options.accept ?? 'application/json, text/plain, */*')
    const cookie = this.jar.header()
    if (cookie) headers.set('cookie', cookie)
    let body = options.body
    if (options.form) {
      body = new URLSearchParams(options.form).toString()
      headers.set('content-type', 'application/x-www-form-urlencoded; charset=utf-8')
    } else if (options.json !== undefined) {
      body = JSON.stringify(options.json)
      headers.set('content-type', 'application/json; charset=utf-8')
    }
    let response
    try {
      response = await this.fetchImpl(url, {
        method: options.method ?? 'GET',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
      })
    } catch (error) {
      const reason = error?.name === 'TimeoutError' ? '请求超时' : (error?.message ?? String(error))
      throw new FatFishError(`连接 FatFish 失败（${url}）：${reason}`, { code: 'network_error' })
    }
    this.jar.absorb(response)
    return response
  }

  /** 响应是否表示“未登录，被重定向到登录页”。 */
  #isLoginRedirect(response) {
    if (response.status !== 302 && response.status !== 303) return false
    const location = response.headers.get('location') ?? ''
    return location.includes('/login')
  }

  /**
   * 请求；遇到会话失效自动重新登录一次。
   *
   * @param {string} method
   * @param {string} path
   * @param {{ form?: Record<string, string>, json?: unknown, retryAuth?: boolean, accept?: string }} [options]
   */
  async request(method, path, options = {}) {
    await this.ensureLogin()
    const response = await this.#fetch(path, { method, ...options })
    if (
      options.retryAuth !== false &&
      (response.status === 401 || this.#isLoginRedirect(response))
    ) {
      this.logger?.warn?.('FatFish 会话已失效，正在重新登录…')
      await this.login()
      return this.#fetch(path, { method, ...options })
    }
    return response
  }

  /** 抓取 CSRF token（同时建立/续期会话 Cookie）。 */
  async #fetchCsrf() {
    const response = await this.#fetch('/csrf-token')
    if (!response.ok) {
      const body = await readBodySnippet(response)
      throw new FatFishError(`获取 CSRF token 失败（HTTP ${response.status}）：${body}`, {
        status: response.status,
        body,
      })
    }
    let data
    try {
      data = await response.json()
    } catch (error) {
      throw new FatFishError(`CSRF 响应不是 JSON：${error.message}`, { code: 'bad_response' })
    }
    if (!data || typeof data.csrf_token !== 'string') {
      throw new FatFishError('CSRF 响应缺少 csrf_token')
    }
    this.csrfToken = data.csrf_token
    return data
  }

  /** 确保已经登录；并发调用只登录一次。 */
  async ensureLogin() {
    if (this.user) return this.user
    await this.login()
    return this.user
  }

  /** 登录 FatFish。成功后 `this.user` 是服务端的规范用户名。 */
  async login() {
    if (this.loginPromise) return this.loginPromise
    this.loginPromise = this.#loginOnce().finally(() => {
      this.loginPromise = undefined
    })
    return this.loginPromise
  }

  async #loginOnce() {
    this.user = undefined
    this.jar.clear()
    const csrf = await this.#fetchCsrf()
    if (csrf.user) {
      // 同一个 jar 里已有有效会话（例如刚启动就复用了 Cookie 的极端情况）。
      this.user = String(csrf.user)
      this.loggedInAt = Date.now()
      return this.user
    }
    const response = await this.#fetch('/login', {
      method: 'POST',
      form: {
        username: this.username,
        password: this.password,
        csrf_token: csrf.csrf_token,
      },
      accept: 'text/html,application/xhtml+xml',
    })

    if (response.status === 302 || response.status === 303) {
      const location = response.headers.get('location') ?? ''
      if (location.includes('/login')) {
        const body = await readBodySnippet(response)
        throw new FatFishError(`登录被拒绝（重定向回登录页）：${extractHtmlError(body) || body}`, {
          status: response.status,
          code: 'login_rejected',
          body,
        })
      }
      // 登录成功后会话会重新生成，CSRF 也要重新取。
      const refreshed = await this.#fetchCsrf()
      const identity = refreshed.user ? String(refreshed.user) : ''
      if (!identity) {
        throw new FatFishError('登录后仍未建立会话，请检查账号密码或服务端会话配置', {
          code: 'login_failed',
        })
      }
      this.user = identity
      this.loggedInAt = Date.now()
      this.logger?.info?.(`FatFish 登录成功：${this.user}（${this.baseUrl}）`)
      return this.user
    }

    if (response.status === 429) {
      const retry = response.headers.get('retry-after') ?? ''
      throw new FatFishError(`登录被限流，请 ${retry || '稍后'} 秒后再试`, {
        status: 429,
        code: 'rate_limited',
      })
    }

    const body = await readBodySnippet(response)
    const message = extractHtmlError(body) || body || `HTTP ${response.status}`
    throw new FatFishError(`登录失败：${message}`, {
      status: response.status,
      code: 'login_failed',
      body,
    })
  }

  /** 健康检查（无需登录）。 */
  async health() {
    const response = await this.#fetch('/app/health')
    if (!response.ok) return { ok: false, status: response.status }
    try {
      const data = await response.json()
      return { ok: data?.status === 'ok', ...data }
    } catch {
      return { ok: false, status: response.status }
    }
  }

  /** 解析 JSON 响应；失败时抛带正文的错误。 */
  async #json(response, what) {
    if (!response.ok) {
      const body = await readBodySnippet(response)
      throw new FatFishError(`${what}失败（HTTP ${response.status}）：${body}`, {
        status: response.status,
        body,
      })
    }
    try {
      return await response.json()
    } catch (error) {
      throw new FatFishError(`${what}返回的不是 JSON：${error.message}`, { code: 'bad_response' })
    }
  }

  /** 公共频道名列表。 */
  async channels() {
    const response = await this.request('GET', '/channels')
    const data = await this.#json(response, '读取公共频道')
    return Array.isArray(data) ? data.map(String) : []
  }

  /** 机器人所在的私有频道/群组。 */
  async privateChannels() {
    const response = await this.request('GET', '/private_channels')
    const data = await this.#json(response, '读取私有频道')
    return Array.isArray(data) ? data : []
  }

  /** 机器人参与的所有私聊。 */
  async dms() {
    const response = await this.request('GET', '/dms')
    const data = await this.#json(response, '读取私聊')
    return Array.isArray(data) ? data : []
  }

  /**
   * 读取某频道在 `after` 之后有变化的消息。
   *
   * 注意：接口也会返回“更早但被编辑/删除”的消息，调用方需要按 `ts` 与 `deleted`
   * 自行过滤。`after` 使用服务端的 Unix 秒（浮点）。
   *
   * @param {string} channel
   * @param {number} after
   * @param {{ limit?: number }} [options]
   */
  async messages(channel, after = 0, options = {}) {
    const query = new URLSearchParams({ after: String(after) })
    if (options.limit) query.set('limit', String(options.limit))
    const path = `/messages/${encodeURIComponent(channel)}?${query.toString()}`
    const response = await this.request('GET', path)
    const data = await this.#json(response, `读取消息（${channel}）`)
    return Array.isArray(data) ? data : []
  }

  /**
   * 取频道最新一条消息（用于建立初始游标，避免把历史消息当成新指令）。
   *
   * @param {string} channel
   * @returns {Promise<object | undefined>}
   */
  async latestMessage(channel) {
    const rows = await this.messages(channel, 0, { limit: 1 })
    return rows.length > 0 ? rows[rows.length - 1] : undefined
  }

  /**
   * 发送一条文本消息。
   *
   * @param {string} channel
   * @param {string} text
   * @param {number} [replyToId]
   * @returns {Promise<{ ok: true }>}
   */
  async send(channel, text, replyToId) {
    const form = { text: String(text ?? '') }
    if (replyToId !== undefined && replyToId !== null) form.reply_to_id = String(replyToId)
    const path = `/send/${encodeURIComponent(channel)}`
    const response = await this.request('POST', path, { form })
    if (!response.ok) {
      const body = await readBodySnippet(response)
      throw new FatFishError(`发送消息失败（HTTP ${response.status}）：${body}`, {
        status: response.status,
        body,
      })
    }
    const body = (await response.text()).trim()
    if (body && body !== 'ok') {
      throw new FatFishError(`发送消息被拒绝：${body}`, { status: response.status, body })
    }
    return { ok: true }
  }

  /**
   * 编辑自己发过的文本消息（预留给需要“流式改写”的用法）。
   *
   * @param {number} messageId
   * @param {string} text
   */
  async edit(messageId, text) {
    const response = await this.request('POST', `/edit/${Number(messageId)}`, {
      form: { text: String(text ?? '') },
    })
    if (!response.ok) {
      const body = await readBodySnippet(response)
      throw new FatFishError(`编辑消息失败（HTTP ${response.status}）：${body}`, {
        status: response.status,
        body,
      })
    }
    return { ok: true }
  }

  /** 当前登录身份（未登录时为 undefined）。 */
  get identity() {
    return this.user
  }
}
