/**
 * dsh-fatfish-bridge: DSH 流式事件 → FatFish 出站
 *
 * DSH 的正文以 `agent/assistant-stream` 的 `text-delta` 帧到达。FatFish 没有
 * “流式消息”概念，因此这里按 **step** 聚合：每个 step 的可见正文在 attempt
 * 正常提交时作为一条 FatFish 消息发出；`turn/end` 兜底收尾最后一段。
 *
 * 与 QQ 桥接插件相同的两个硬约束：
 *   1. 只放行 `chunk.type === 'text-delta'`，reasoning / tool-call 一律丢弃；
 *   2. 只处理**本桥接投喂的回合**（ownTurn），WebUI 里自己发起的对话不回显到聊天软件。
 */

export class OutboundRouter {
  /**
   * @param {{
   *   control: import('./dsh-control.js').DshControl,
   *   reply: (channel: string, text: string) => Promise<void>,
   *   isOwnTurn: (sessionId: string) => boolean,
   *   logger: { info: Function, warn: Function, error: Function, debug?: Function },
   * }} options
   */
  constructor(options) {
    this.control = options.control
    this.reply = options.reply
    this.isOwnTurn = options.isOwnTurn
    this.logger = options.logger
    this.states = new Map()
    this.pending = new Set()
  }

  /** 挂载监听；返回 disposer。 */
  attach(ctx) {
    const offFrame = ctx.on('agent/assistant-stream', (...args) => {
      const payload = args[0]
      this.enqueue(payload?.agent?.id, () => this.onFrame(payload))
    })
    const offSession = ctx.on('session/event', (...args) => {
      const session = args[0]
      const event = args[1]
      this.enqueue(session?.id, () => this.onSessionEvent(session?.id, event))
    })
    return () => {
      for (const off of [offFrame, offSession]) {
        if (typeof off === 'function') off()
      }
    }
  }

  /** 该事件是否应出站：会话已绑定频道，且当前回合由本桥接发起。 */
  #channelFor(sessionId) {
    const id = String(sessionId ?? '')
    if (!id) return undefined
    if (!this.isOwnTurn(id)) return undefined
    return this.control.channelOf(id)
  }

  /** 串行化同一会话的事件处理（emit 不 await，顺序要自己保证）。 */
  enqueue(sessionId, task) {
    const id = String(sessionId ?? '')
    if (!id) return
    const channel = this.#channelFor(id)
    if (!channel) return
    const existing = this.states.get(id)
    const previous = existing?.chain ?? Promise.resolve()
    const next = previous
      .then(task)
      .catch((error) => this.logger.error('出站事件处理失败', error))
      .finally(() => this.pending.delete(next))
    this.pending.add(next)
    if (existing) {
      existing.chain = next
      existing.channel = channel
    } else {
      this.states.set(id, { chain: next, channel, buffer: '', chunks: 0 })
    }
  }

  async onFrame(payload) {
    const sessionId = String(payload?.agent?.id ?? '')
    const frame = payload?.frame
    if (!sessionId || !frame) return
    const channel = this.#channelFor(sessionId)
    if (!channel) return
    let state = this.states.get(sessionId)
    if (!state) {
      state = { chain: Promise.resolve(), channel, buffer: '', chunks: 0 }
      this.states.set(sessionId, state)
    }

    if (frame.type === 'end') {
      const outcome = frame.outcome
      if (outcome?.kind === 'committed' && outcome?.eventType === 'assistant/message') {
        await this.flush(sessionId, state)
      } else {
        // 没有可见正文的 attempt（工具调用、被放弃的尝试）不产生消息。
        this.reset(state)
      }
      return
    }

    if (frame.type !== 'chunk') return
    if (frame.chunk?.type !== 'text-delta') return
    const text = frame.chunk.text
    if (typeof text !== 'string' || text.length === 0) return
    state.channel = channel
    state.buffer += text
    state.chunks += 1
  }

  async onSessionEvent(sessionId, event) {
    const id = String(sessionId ?? '')
    if (!id || !event?.type) return
    const channel = this.#channelFor(id)
    if (!channel) return
    const state = this.states.get(id)
    if (!state) return
    if (event.type !== 'turn/end') return
    const reason = event.data?.reason
    if (reason?.kind === 'error') {
      const error = reason.error
      const detail =
        error && typeof error === 'object'
          ? `${String(error.message ?? '')}${error.code ? `（${String(error.code)}）` : ''}`
          : String(reason.error ?? '')
      await this.reply(channel, `⚠️ DSH 回合出错：${detail || '未知错误'}`).catch(() => undefined)
    }
    try {
      await this.flush(id, state)
    } finally {
      this.states.delete(id)
    }
  }

  /** 收掉当前段：有正文就发一条消息，否则静默。 */
  async flush(sessionId, state) {
    const text = state.buffer
    const chunks = state.chunks
    const channel = state.channel
    this.reset(state)
    if (!text.trim() || !channel) return
    try {
      await this.reply(channel, text)
      this.logger.info(
        `出站：${channel} ← ${text.length} 字（${chunks} 个增量，session ${sessionId}）`,
      )
    } catch (error) {
      this.logger.error(`出站发送失败（${channel}）：${error.message}`)
    }
  }

  reset(state) {
    state.buffer = ''
    state.chunks = 0
  }

  /** 等待所有在途事件处理完成（测试 / 关闭时用）。 */
  async drain() {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending])
    }
  }
}
