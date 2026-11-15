/**
 * dsh-fatfish-bridge: 入站轮询与消息路由
 *
 * FatFish 没有给外部程序提供“读消息”的令牌 API，但登录后的会话可以读取
 * `GET /messages/<channel>?after=<ts>`。本模块就按这个游标轮询：
 *
 *   1. 维护“要看的频道”集合（配置 + 已绑定频道 + 机器人所在私聊）；
 *   2. 每个频道首次轮询只取最新一条建立基线，**不把历史消息当成新指令**；
 *   3. 之后只处理 `ts > 游标` 且未删除、非机器人自己发的消息；
 *   4. 审批/提问待决时，消息优先交给交互层；命令交给命令层；其余发给 DSH。
 *
 * 安全默认：没有配置 `allowed_senders` 时只服务私聊；公共频道/群组必须显式授权用户，
 * 否则任何群成员都能通过机器人操作本机 DSH。
 */

import {
  buildPrompt,
  errorMessage,
  isSlashCommand,
  mentionsBot,
  stripMention,
} from './text.js'
import {
  isDirectMessageChannel,
  parseChannelList,
  parseSenderList,
} from './config.js'

const CHANNEL_REFRESH_MS = 10_000
const CURSOR_EPSILON = 0.001

export class InboundBridge {
  /**
   * @param {{
   *   client: import('./fatfish-client.js').FatFishClient,
   *   control: import('./dsh-control.js').DshControl,
   *   commands: { dispatch: (channel: string, text: string) => Promise<boolean> },
   *   interactions: import('./interactions.js').Interactions,
   *   state: import('./state.js').BridgeState,
   *   config: ReturnType<import('./config.js').resolveBridgeConfig>,
   *   reply: (channel: string, text: string) => Promise<void>,
   *   logger: { info: Function, warn: Function, error: Function, debug?: Function },
   * }} options
   */
  constructor(options) {
    this.client = options.client
    this.control = options.control
    this.commands = options.commands
    this.interactions = options.interactions
    this.state = options.state
    this.config = options.config
    this.reply = options.reply
    this.logger = options.logger
    this.stopped = false
    this.timer = undefined
    this.running = undefined
    this.channels = []
    this.channelRefreshedAt = 0
    this.initialized = new Set()
    this.warnedEmptyAllowlist = false
    this.startedAt = Math.floor(Date.now() / 1000)
    this.firstRefreshDone = false
    this.knownAtStart = new Set()
    this.warnAt = new Map()
  }

  /** 同一类错误最多每分钟记一条，避免 FatFish 没开时刷屏。 */
  #warnThrottled(key, message) {
    const now = Date.now()
    const last = this.warnAt.get(key) ?? 0
    if (now - last < 60_000) return
    this.warnAt.set(key, now)
    this.logger.warn(message)
  }

  /** 启动轮询循环。 */
  start() {
    if (this.stopped || this.timer !== undefined) return
    this.stopped = false
    this.startedAt = Math.floor(Date.now() / 1000)
    void this.#loop()
    this.logger.info(`入站轮询已启动（间隔 ${this.config.poll_interval_ms}ms）`)
  }

  /** 停止轮询并等待当前轮完成。 */
  async stop() {
    this.stopped = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    await this.running?.catch(() => undefined)
  }

  async #loop() {
    if (this.stopped) return
    this.running = this.tick()
    try {
      await this.running
    } catch (error) {
      this.logger.error('入站轮询失败', error)
    } finally {
      this.running = undefined
    }
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.#loop()
    }, this.config.poll_interval_ms)
    this.timer.unref?.()
  }

  /** 执行一轮：刷新频道列表 + 逐频道拉取。 */
  async tick() {
    const now = Date.now()
    if (now - this.channelRefreshedAt > CHANNEL_REFRESH_MS) {
      await this.refreshChannels()
      this.channelRefreshedAt = now
      if (!this.firstRefreshDone) {
        // 启动时已在列表里的频道：首轮只建立游标，跳过历史消息。
        this.knownAtStart = new Set(this.channels)
        this.firstRefreshDone = true
      }
    }
    for (const channel of this.channels) {
      if (this.stopped) return
      try {
        await this.pollChannel(channel)
      } catch (error) {
        this.#warnThrottled(
          `poll:${channel}`,
          `轮询频道 ${channel} 失败：${errorMessage(error)}`,
        )
      }
    }
  }

  /** 计算要看的频道集合。 */
  async refreshChannels() {
    const explicit = parseChannelList(this.config.channels)
    const watchAll = explicit.length === 0 || explicit.includes('*')
    const names = new Set()

    if (watchAll) {
      try {
        for (const channel of await this.client.channels()) names.add(channel)
        for (const item of await this.client.privateChannels()) {
          if (item?.channel) names.add(String(item.channel))
        }
      } catch (error) {
        this.#warnThrottled(
          'refresh:channels',
          `刷新频道列表失败：${errorMessage(error)}`,
        )
      }
    } else {
      for (const item of explicit) {
        if (item === '*') continue
        names.add(item)
      }
      // 允许写私有频道的“名字”而不是 private:<id>。
      const unresolved = [...names].filter((name) => !name.includes(':'))
      if (unresolved.length > 0) {
        try {
          const privates = await this.client.privateChannels()
          for (const item of privates) {
            if (unresolved.includes(String(item.name))) {
              names.delete(String(item.name))
              names.add(String(item.channel))
            }
          }
        } catch {
          // 名字解析失败就按原样尝试
        }
      }
    }

    if (this.config.watch_dms) {
      try {
        for (const item of await this.client.dms()) {
          if (item?.channel) names.add(String(item.channel))
        }
      } catch (error) {
        this.#warnThrottled(
          'refresh:dms',
          `刷新私聊列表失败：${errorMessage(error)}`,
        )
      }
    }

    // 已经绑过会话的频道必须继续轮询，否则改配置会让已有绑定“失联”。
    for (const channel of this.state.channels()) names.add(channel)

    const next = [...names].filter(Boolean)
    const added = next.filter((channel) => !this.channels.includes(channel))
    const removed = this.channels.filter((channel) => !next.includes(channel))
    this.channels = next
    if (added.length > 0) this.logger.info(`开始监听频道：${added.join('、')}`)
    if (removed.length > 0) this.logger.info(`停止监听频道：${removed.join('、')}`)
  }

  /** 轮询一个频道。 */
  async pollChannel(channel) {
    let cursor = this.state.cursor(channel)
    if (cursor <= 0) {
      if (this.firstRefreshDone && !this.knownAtStart.has(channel)) {
        // 运行中新出现的频道（例如刚开始的私聊）：从“桥接启动时刻”开始收，
        // 既不会漏掉刚刚那条消息，也不会把陈年历史当成新指令。
        cursor = Math.max(0, this.startedAt - CURSOR_EPSILON)
        this.state.setCursor(channel, cursor)
      } else {
        const latest = await this.client.latestMessage(channel)
        if (latest?.ts) {
          this.state.setCursor(channel, Number(latest.ts))
          this.initialized.add(channel)
          this.logger.debug?.(`频道 ${channel} 建立初始游标 ${latest.ts}`)
          return
        }
        // 频道还没有消息：保持基线未建立，下次再看。
        return
      }
    }

    const after = cursor > 0 ? Math.max(0, cursor - CURSOR_EPSILON) : 0
    const rows = await this.client.messages(channel, after)
    if (!Array.isArray(rows) || rows.length === 0) {
      this.initialized.add(channel)
      return
    }

    const botName = String(this.client.identity ?? this.config.username ?? '').toLowerCase()
    const fresh = rows
      .filter((row) => row && row.deleted !== 1 && row.deleted !== true)
      .filter((row) => String(row.sender ?? '').toLowerCase() !== botName)
      .filter((row) => row.content_type !== 'system')
      .filter((row) => !this.state.hasSeen(channel, row.id))
      .filter((row) => Number(row.ts) > 0 && Number(row.ts) >= cursor - CURSOR_EPSILON)
      .sort((a, b) => Number(a.ts) - Number(b.ts) || Number(a.id) - Number(b.id))

    this.initialized.add(channel)
    let maxTs = cursor
    for (const row of fresh) {
      this.state.markSeen(channel, row.id)
      maxTs = Math.max(maxTs, Number(row.ts))
      try {
        await this.handleMessage(channel, row)
      } catch (error) {
        this.logger.error(`处理 ${channel} 的消息失败：${errorMessage(error)}`)
      }
    }
    if (maxTs > cursor) this.state.setCursor(channel, maxTs)
  }

  /** 处理一条新消息。 */
  async handleMessage(channel, message) {
    const sender = String(message.sender ?? '')
    const text = String(message.content ?? '')
    const files = message.filename ? [String(message.filename)] : []
    if (!text.trim() && files.length === 0) return

    const allowed = parseSenderList(this.config.allowed_senders).map((item) => item.toLowerCase())
    const senderAllowed = allowed.length > 0 && allowed.includes(sender.toLowerCase())
    const direct = isDirectMessageChannel(channel)

    if (allowed.length === 0 && !direct) {
      if (!this.warnedEmptyAllowlist) {
        this.warnedEmptyAllowlist = true
        this.logger.warn(
          'allowed_senders 为空：当前只服务私聊。要在公共频道/群组使用，请先把你的 FatFish 用户名加入 allowed_senders。',
        )
      }
      return
    }
    if (allowed.length > 0 && !senderAllowed) {
      this.logger.debug?.(`忽略未授权用户 ${sender} 在 ${channel} 的消息`)
      return
    }

    const botName = String(this.client.identity ?? this.config.username ?? '')
    const command = isSlashCommand(text)

    // 1) 审批 / 提问待决：必须排在 @ 检查之前——群里的回复通常是裸的 `y` 或 `1`。
    if (this.interactions.approval.hasPending(channel)) {
      this.interactions.approval.handle(channel, text.trim())
      return
    }
    if (this.interactions.question.hasPending(channel)) {
      this.interactions.question.handle(channel, text.trim())
      return
    }

    let body = text
    if (!direct && this.config.mention_required && !command) {
      if (!mentionsBot(body, botName)) return
      body = stripMention(body, botName)
    } else if (!direct && mentionsBot(body, botName)) {
      body = stripMention(body, botName)
    }
    body = body.trim()

    // 2) 命令。
    if (this.commands && (await this.commands.dispatch(channel, body))) return

    // 3) 普通对话。
    const prompt = buildPrompt({
      sender,
      text: body,
      files,
      baseUrl: this.config.base_url,
      direct,
    })
    if (!prompt) return
    const result = await this.control.send(channel, prompt)
    if (!result.ok) {
      this.logger.warn(`投递到 DSH 失败：${result.reason}`)
      await this.reply(channel, `未能发送给 DSH：${result.reason}`).catch(() => undefined)
      return
    }
    this.logger.info(
      `入站：${channel} ← ${sender}（${result.mode}${result.sessionId ? `，${result.sessionId}` : ''}）`,
    )
  }
}
