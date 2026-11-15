/**
 * dsh-fatfish-bridge: 审批与提问的远端作答
 *
 * Agent 在受控会话里请求审批或提问时，DSH 会触发两个公开的 waterfall 事件：
 *   - `approval/request`（`@deepseek-ai/dsh-user-approval`）
 *   - `user-questions/request`（`@deepseek-ai/dsh-user-questions`）
 *
 * 监听器必须 `{ prepend: true }`：WebUI 的宿主 answerer 先注册时会占住整条链，
 * 不抢先就永远轮不到聊天软件侧。非受控会话或非本桥接发起的回合一律 `next()`，
 * 把交互完整交还给 WebUI。
 */

const DEFAULT_TIMEOUT_MS = 300_000
const APPROVE_WORDS = new Set(['y', 'yes', '是', '允许', '同意', '批准', '1', '好', '可以'])
const REJECT_WORDS = new Set(['n', 'no', '否', '拒绝', '不同意', '2', '不'])
const CANCEL_WORDS = new Set(['/取消', '/cancel', '取消'])

/** 单个频道的待决槽（审批与提问各一个）。 */
class PendingSlot {
  constructor(kind) {
    this.kind = kind
    /** @type {Map<string, {resolve: (value: string) => void, timer: NodeJS.Timeout}>} */
    this.current = new Map()
  }

  hasPending(channel) {
    return this.current.has(channel)
  }

  /** 入站消息被本层消费（返回 true 即消息不再转发给 agent）。 */
  handle(channel, text) {
    const pending = this.current.get(channel)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.current.delete(channel)
    pending.resolve(text)
    return true
  }

  /** 登记一次待决；新请求顶掉旧请求（旧的 fail-closed）。 */
  wait(channel, timeoutMs, logger) {
    const previous = this.current.get(channel)
    if (previous) {
      clearTimeout(previous.timer)
      this.current.delete(channel)
      logger.warn(`[${this.kind}] ${channel} 已有待决交互，旧请求被新请求顶掉`)
      previous.resolve(this.kind === 'approval' ? '__superseded__' : '__cancel__')
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.current.delete(channel)
        logger.warn(`[${this.kind}] ${channel} 等待超时（${timeoutMs}ms），按拒绝/未作答处理`)
        resolve('__timeout__')
      }, timeoutMs)
      timer.unref?.()
      this.current.set(channel, { resolve, timer })
    })
  }

  clear() {
    for (const pending of this.current.values()) {
      clearTimeout(pending.timer)
      pending.resolve('__cancel__')
    }
    this.current.clear()
  }
}

export class Interactions {
  /**
   * @param {{
   *   control: import('./dsh-control.js').DshControl,
   *   reply: (channel: string, text: string) => Promise<void>,
   *   isOwnTurn: (sessionId: string) => boolean,
   *   timeoutMs: number,
   *   logger: { info: Function, warn: Function, error: Function, debug?: Function },
   * }} options
   */
  constructor(options) {
    this.control = options.control
    this.reply = options.reply
    this.isOwnTurn = options.isOwnTurn
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.logger = options.logger
    this.approvalSlot = new PendingSlot('approval')
    this.questionSlot = new PendingSlot('question')

    this.approval = {
      hasPending: (channel) => this.approvalSlot.hasPending(channel),
      handle: (channel, text) => this.approvalSlot.handle(channel, text),
    }
    this.question = {
      hasPending: (channel) => this.questionSlot.hasPending(channel),
      handle: (channel, text) => this.questionSlot.handle(channel, text),
    }
  }

  /** 挂载两个 waterfall 监听；返回 disposer。 */
  attach(ctx) {
    const offApproval = ctx.on('approval/request', (...args) => this.onApproval(args[0], args[1]), {
      prepend: true,
    })
    const offQuestion = ctx.on(
      'user-questions/request',
      (...args) => this.onQuestion(args[0], args[1]),
      { prepend: true },
    )
    return () => {
      this.approvalSlot.clear()
      this.questionSlot.clear()
      for (const off of [offApproval, offQuestion]) {
        if (typeof off === 'function') off()
      }
    }
  }

  /** 从官方 Agent 载体取 sessionId。 */
  #sessionIdOf(holder) {
    const id = holder?.session?.id ?? holder?.id
    return id === undefined ? undefined : String(id)
  }

  /** 受控且属于本桥接回合的会话才接管。 */
  #channelFor(agentLike) {
    const sessionId = this.#sessionIdOf(agentLike)
    if (!sessionId) return undefined
    if (!this.isOwnTurn(sessionId)) return undefined
    return this.control.channelOf(sessionId)
  }

  async onApproval(request, next) {
    const channel = this.#channelFor(request?.agent)
    if (!channel) return next()

    const tool = request?.toolName ?? '未知工具'
    const reason = request?.reason ? `\n原因：${request.reason}` : ''
    await this.reply(
      channel,
      [
        '需要你批准一次操作',
        `工具：${tool}${reason}`,
        '',
        '回复 y / 是 / 允许 / 同意 → 仅本次允许',
        '回复 n / 否 / 拒绝 / 不同意 → 拒绝',
        '回复 /取消 → 取消本次操作',
      ].join('\n'),
    ).catch(() => undefined)

    let raw
    try {
      raw = await this.approvalSlot.wait(channel, this.timeoutMs, this.logger)
    } catch (error) {
      this.logger.error('审批等待异常', error)
      return 'unavailable'
    }
    if (request?.signal?.aborted) return 'cancelled'

    const verdict = String(raw).trim().toLowerCase()
    if (verdict === '__timeout__' || verdict === '__superseded__') {
      await this.reply(channel, '审批等待超时，已按拒绝处理。').catch(() => undefined)
      return 'rejected'
    }
    if (CANCEL_WORDS.has(verdict)) {
      await this.reply(channel, '已取消本次操作。').catch(() => undefined)
      return 'cancelled'
    }
    if (APPROVE_WORDS.has(verdict)) {
      await this.reply(channel, '已允许（仅本次）。').catch(() => undefined)
      return 'allowed-once'
    }
    if (REJECT_WORDS.has(verdict)) {
      await this.reply(channel, '已拒绝。').catch(() => undefined)
      return 'rejected'
    }
    await this.reply(
      channel,
      `没有识别为批准或拒绝（收到「${String(raw).slice(0, 20)}」），本次按拒绝处理。`,
    ).catch(() => undefined)
    return 'rejected'
  }

  async onQuestion(request, next) {
    const channel = this.#channelFor(request?.agent)
    const questions = Array.isArray(request?.questions) ? request.questions : []
    if (!channel || questions.length === 0) return next()

    const answers = []
    for (let index = 0; index < questions.length; index += 1) {
      const question = questions[index]
      const options = Array.isArray(question.options) ? question.options : []
      const lines = [`${question.header ? `[${question.header}] ` : ''}${question.question}`]
      if (question.detail) lines.push(question.detail)
      if (options.length > 0) {
        lines.push('')
        options.forEach((option, optionIndex) => {
          lines.push(
            option.description
              ? `${optionIndex + 1}. ${option.label}（${option.description}）`
              : `${optionIndex + 1}. ${option.label}`,
          )
        })
        lines.push('')
        lines.push(
          question.multiSelect ? '回复序号，多选用逗号分隔，例如 1,3' : '回复序号选择一项',
        )
      }
      lines.push(
        questions.length > 1
          ? `（第 ${index + 1}/${questions.length} 题；/跳过 跳过，/取消 放弃整次提问）`
          : '（/跳过 跳过，/取消 放弃整次提问；也可以直接回复自定义文本）',
      )
      await this.reply(channel, lines.join('\n')).catch(() => undefined)

      const raw = await this.questionSlot.wait(channel, this.timeoutMs, this.logger)
      const text = String(raw).trim()
      if (text === '__timeout__' || text === '__cancel__' || CANCEL_WORDS.has(text.toLowerCase())) {
        await this.reply(channel, '提问已取消。').catch(() => undefined)
        throw new Error('用户取消了提问，未作答')
      }
      if (text === '/跳过' || text.toLowerCase() === '/skip') {
        answers.push({ id: question.id, selected: [] })
        continue
      }
      const picked = []
      if (options.length > 0) {
        for (const part of text.split(/[,，\s]+/).filter(Boolean)) {
          const number = Number(part)
          if (Number.isInteger(number) && number >= 1 && number <= options.length) {
            picked.push(options[number - 1].label)
          }
        }
      }
      if (picked.length > 0) {
        answers.push({
          id: question.id,
          selected: question.multiSelect ? picked : [picked[0]],
        })
      } else {
        answers.push({ id: question.id, selected: [], custom: text })
      }
    }
    return { answers }
  }
}
