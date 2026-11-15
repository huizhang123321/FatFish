/**
 * dsh-fatfish-bridge: 持久化状态
 *
 * 只保存“桥接自己的东西”：
 *   - 每个 FatFish 频道绑定到哪个 DSH 会话、用哪个工作区；
 *   - 每个频道已经读到的时间游标；
 *   - 最近处理过的消息 id（配合游标做去重，避免同一时间戳的消息漏收或重收）。
 *
 * 不保存 DSH 的模型/权限/会话内容——那些始终属于 DSH 官方存储。
 *
 * 文件写在 `$DSH_HOME/fatfish-bridge/state.json`；写入采用“临时文件 + 原子重命名”，
 * 进程被杀不会留下半截 JSON。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const STATE_VERSION = 1
const SEEN_LIMIT = 200

/** 深拷贝一个 JSON 值，避免调用方改到内部状态。 */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** 空状态。 */
function emptyState() {
  return { version: STATE_VERSION, updatedAt: Date.now(), channels: {}, cursors: {}, seen: {} }
}

export class BridgeState {
  /**
   * @param {{ file: string, logger?: { warn: Function, info?: Function, error?: Function } }} options
   */
  constructor(options) {
    this.file = options.file
    this.logger = options.logger
    this.data = emptyState()
    this.loaded = false
    this.saveTimer = undefined
    this.saveChain = Promise.resolve()
  }

  /** 读取状态文件；不存在视为全新安装，损坏则备份后重建。 */
  async load() {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      this.data = this.#normalize(parsed)
      this.loaded = true
      return this.data
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        this.loaded = true
        return this.data
      }
      const backup = `${this.file}.corrupt-${Date.now()}`
      try {
        await fs.rename(this.file, backup)
      } catch {
        // 备份失败也不阻塞启动
      }
      this.logger?.warn?.(`状态文件无法解析，已备份到 ${backup}：${error.message}`)
      this.data = emptyState()
      this.loaded = true
      return this.data
    }
  }

  /** 兼容旧字段/坏字段，保证后续代码拿到稳定形状。 */
  #normalize(parsed) {
    const base = emptyState()
    if (!parsed || typeof parsed !== 'object') return base
    base.updatedAt = Number(parsed.updatedAt) || Date.now()
    if (parsed.channels && typeof parsed.channels === 'object') {
      for (const [channel, binding] of Object.entries(parsed.channels)) {
        if (!binding || typeof binding !== 'object') continue
        const normalized = {}
        if (typeof binding.sessionId === 'string' && binding.sessionId) {
          normalized.sessionId = binding.sessionId
        }
        if (binding.workspaceId !== undefined && binding.workspaceId !== null) {
          normalized.workspaceId = String(binding.workspaceId)
        }
        if (typeof binding.workspacePath === 'string' && binding.workspacePath) {
          normalized.workspacePath = binding.workspacePath
        }
        if (typeof binding.title === 'string' && binding.title) normalized.title = binding.title
        if (!normalized.sessionId && !normalized.workspacePath && !normalized.workspaceId) continue
        normalized.updatedAt = Number(binding.updatedAt) || Date.now()
        base.channels[channel] = normalized
      }
    }
    if (parsed.cursors && typeof parsed.cursors === 'object') {
      for (const [channel, cursor] of Object.entries(parsed.cursors)) {
        const value = Number(cursor)
        if (Number.isFinite(value) && value >= 0) base.cursors[channel] = value
      }
    }
    if (parsed.seen && typeof parsed.seen === 'object') {
      for (const [channel, ids] of Object.entries(parsed.seen)) {
        if (!Array.isArray(ids)) continue
        base.seen[channel] = ids
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0)
          .slice(-SEEN_LIMIT)
      }
    }
    return base
  }

  /** 读取频道绑定。 */
  channel(channel) {
    return clone(this.data.channels[channel])
  }

  /** 写入频道绑定并返回写入后的副本。 */
  setChannel(channel, binding) {
    const next = {
      ...(binding ?? {}),
      updatedAt: Date.now(),
    }
    this.data.channels[channel] = next
    this.data.updatedAt = Date.now()
    this.saveSoon()
    return clone(next)
  }

  /** 删除频道绑定（游标保留，避免删绑后重放旧消息）。 */
  removeChannel(channel) {
    if (this.data.channels[channel] === undefined) return
    delete this.data.channels[channel]
    this.data.updatedAt = Date.now()
    this.saveSoon()
  }

  /** 列出全部绑定（只读副本）。 */
  channels() {
    return Object.keys(this.data.channels)
  }

  /** 读取频道游标。 */
  cursor(channel) {
    return this.data.cursors[channel] ?? 0
  }

  /** 推进频道游标；只在变大时写入。 */
  setCursor(channel, ts) {
    const value = Number(ts)
    if (!Number.isFinite(value)) return
    if (value <= (this.data.cursors[channel] ?? 0)) return
    this.data.cursors[channel] = value
    this.data.updatedAt = Date.now()
    this.saveSoon()
  }

  /** 该消息 id 是否已经处理过。 */
  hasSeen(channel, id) {
    const list = this.data.seen[channel]
    return Array.isArray(list) && list.includes(Number(id))
  }

  /** 记录已处理的消息 id（有界，只留最近 200 条）。 */
  markSeen(channel, id) {
    const value = Number(id)
    if (!Number.isInteger(value) || value <= 0) return
    const list = this.data.seen[channel] ?? []
    if (list.includes(value)) return
    list.push(value)
    if (list.length > SEEN_LIMIT) list.splice(0, list.length - SEEN_LIMIT)
    this.data.seen[channel] = list
  }

  /** 延迟合并写入（500ms），避免轮询时频繁落盘。 */
  saveSoon() {
    if (this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.flush()
    }, 500)
    this.saveTimer.unref?.()
  }

  /** 立即落盘并等待完成。 */
  async flush() {
    const payload = JSON.stringify(this.data, null, 2)
    const file = this.file
    this.saveChain = this.saveChain.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      const temp = `${file}.${process.pid}.tmp`
      await fs.writeFile(temp, payload, 'utf8')
      await fs.rename(temp, file)
    })
    try {
      await this.saveChain
    } catch (error) {
      this.logger?.error?.(`状态写入失败：${error.message}`)
      throw error
    }
  }

  /** 停止延迟写入并落盘（dispose 时调用）。 */
  async close() {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    await this.flush().catch(() => undefined)
  }

  /** 供测试/诊断查看当前内容。 */
  snapshot() {
    return clone(this.data)
  }
}
