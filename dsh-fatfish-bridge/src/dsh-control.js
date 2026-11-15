/**
 * dsh-fatfish-bridge: DSH 会话控制层
 *
 * 把 FatFish 的“频道”映射到 DSH 的“会话”：
 *   - 每个频道最多绑定一个 DSH 会话，绑定关系持久化在 BridgeState；
 *   - 不在绑定时创建会话：第一次真正发消息时才建，避免装完插件就留下空会话；
 *   - 驱动方式与 DSH WebUI 一致：优先复用 live agent，忙时 steer、闲时 followup；
 *   - 不维护模型/权限副本，全部读取 DSH 官方服务。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { randomUUID } from 'node:crypto'
import { errorMessage } from './text.js'

/** 调用方参数非法（失败必吵，不静默兜底）。 */
export class ControlInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ControlInputError'
  }
}

/** 排他锁冲突：会话已被另一个写句柄持有。 */
export function isSessionAlreadyOwned(error) {
  if (error?.name === 'SessionAlreadyOwnedError') return true
  const message = errorMessage(error)
  return (
    message.includes('is already owned by an active write handle') ||
    message.includes('already owned') ||
    message.includes('SessionAlreadyOwnedError')
  )
}

/** 会话确定不存在。 */
export function isSessionNotFound(error) {
  if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return true
  if (error?.name === 'SessionQueryError' && /not found/i.test(errorMessage(error))) return true
  return /not found/i.test(errorMessage(error))
}

/** resume 失败文案是否表示“会话已经不在了”。 */
function looksLikeNotFound(reason) {
  return /not found|不存在|已被删除/i.test(String(reason ?? ''))
}

/** 本桥接投喂过的消息 id 记忆上限。 */
const OWN_MESSAGE_MEMORY = 256

function normalizeSelection(selection) {
  return {
    provider: String(selection.provider),
    model: String(selection.model),
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: String(selection.reasoningEffort) }),
  }
}

export class DshControl {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {{
   *   state: import('./state.js').BridgeState,
   *   config: ReturnType<import('./config.js').resolveBridgeConfig>,
   *   logger: { info: Function, warn: Function, error: Function, debug?: Function },
   *   defaultWorkspacePath: string,
   * }} options
   */
  constructor(ctx, options) {
    this.ctx = ctx
    this.state = options.state
    this.config = options.config
    this.logger = options.logger
    this.defaultWorkspacePath = options.defaultWorkspacePath
    this.ownedHandles = new Map()
    this.ownMessageIds = new Set()
    this.ownMessageOrder = []
    /**
     * sessionId → 最近一次由哪个 FatFish 频道投喂。
     *
     * 反向映射不能只看当前绑定：用户可能在回合运行中执行 `/切换` 清空绑定，
     * 但这一回合的回复仍应回到原频道。下一次从新频道发消息会覆盖它。
     */
    this.sessionChannels = new Map()
    // DSH 包的工厂由入口注入：既让本模块可以脱离 DSH 运行时做单测，
    // 又保证生产路径使用的是官方 `SessionId` / `createUserMessage`。
    this.sessionId = options.sessionId ?? ((id) => id)
    this.createUserMessage =
      options.createUserMessage ??
      ((input) => ({
        id: randomUUID(),
        ...input,
      }))
    this.ManualCompactionError = options.ManualCompactionError
  }

  /** 可选服务：不存在时返回 undefined，由调用方决定降级。 */
  #service(key) {
    try {
      return this.ctx.get(key) ?? undefined
    } catch {
      return undefined
    }
  }

  /** 读取频道绑定。 */
  binding(channel) {
    return this.state.channel(channel)
  }

  /** 该会话当前绑定到哪个 FatFish 频道（没有则 undefined）。 */
  channelOf(sessionId) {
    const target = String(sessionId ?? '')
    if (!target) return undefined
    for (const channel of this.state.channels()) {
      if (this.state.channel(channel)?.sessionId === target) return channel
    }
    return this.sessionChannels.get(target)
  }

  /** 该消息是否由本桥接投喂（用于判定“这个回合是不是 FatFish 发起的”）。 */
  isOwnMessage(messageId) {
    return this.ownMessageIds.has(String(messageId))
  }

  rememberOwnMessage(messageId) {
    const id = String(messageId)
    this.ownMessageIds.add(id)
    this.ownMessageOrder.push(id)
    while (this.ownMessageOrder.length > OWN_MESSAGE_MEMORY) {
      const oldest = this.ownMessageOrder.shift()
      if (oldest !== undefined) this.ownMessageIds.delete(oldest)
    }
  }

  // ───────────────────────── 工作区 ─────────────────────────

  /** 列出 DSH 工作区。 */
  listWorkspaces() {
    const registry = this.ctx.workspaceRegistry
    const archived = new Set((registry.archivedSessionIds ?? []).map(String))
    return registry.list().map((workspace) => ({
      id: String(workspace.id),
      title: workspace.title ?? '',
      path: workspace.path,
      sessionIds: workspace.sessionIds.map(String),
      archivedSessionIds: archived,
    }))
  }

  /** 按 id / 路径 / 标题解析工作区。 */
  resolveWorkspace(arg) {
    const raw = String(arg ?? '').trim()
    if (!raw) return undefined
    const workspaces = this.listWorkspaces()
    const byId = workspaces.find((workspace) => workspace.id === raw)
    if (byId) return byId
    const wanted = normalizePath(raw)
    const byPath = workspaces.find((workspace) => normalizePath(workspace.path) === wanted)
    if (byPath) return byPath
    return workspaces.find((workspace) => workspace.title?.toLowerCase() === raw.toLowerCase())
  }

  /** 注册工作区（不存在时创建目录并注册）。 */
  async ensureWorkspace(targetPath) {
    const registry = this.ctx.workspaceRegistry
    const absolute = path.resolve(targetPath)
    const existing = await registry.resolveByPath(absolute)
    if (existing) {
      return { workspace: existing, created: false, createdDir: false }
    }
    let createdDir = false
    try {
      const stat = await fs.stat(absolute)
      if (!stat.isDirectory()) {
        throw new ControlInputError(`该路径是文件，不是目录：${absolute}`)
      }
    } catch (error) {
      if (error instanceof ControlInputError) throw error
      if (error?.code !== 'ENOENT') {
        throw new ControlInputError(`检查路径失败：${errorMessage(error)}`)
      }
      await fs.mkdir(absolute, { recursive: true })
      createdDir = true
    }
    const workspace = await registry.create(absolute)
    return { workspace, created: true, createdDir }
  }

  // ───────────────────────── 会话 ─────────────────────────

  /** 解析本次要用的 agent preset。 */
  async #resolvePreset(preferred) {
    const presets = this.#service('agentPresets')
    if (!presets) return undefined
    if (preferred) {
      try {
        return (await presets.resolve(preferred)).id
      } catch (error) {
        this.logger.warn(`会话记录的 preset「${preferred}」不可用，回退默认：${errorMessage(error)}`)
      }
    }
    return (await presets.resolve()).id
  }

  /** 读取 DSH 官方默认模型，作为新会话的初始选择。 */
  #defaultAgentOptions() {
    const service = this.#service('agentDefaultModel')
    if (!service) return undefined
    try {
      const selection = service.currentSelection()
      if (selection?.provider && selection?.model) {
        return normalizeSelection(selection)
      }
    } catch {
      // DSH 会用自己的默认
    }
    return undefined
  }

  /** 构造 agent 的 setup：挂载 preset，获得与 WebUI 一致的完整工具集。 */
  #agentSetup(presetId) {
    const presets = this.#service('agentPresets')
    if (!presets) return undefined
    return (agentCtx) => presets.mount(agentCtx, presetId).then(() => undefined)
  }

  /**
   * 在指定工作区新建 DSH 会话并绑定到频道。
   *
   * @param {string} channel
   * @param {string} [pathArg] 工作区路径；相对路径以用户主目录为基准。
   */
  async createSession(channel, pathArg) {
    if (!this.config.allow_create_session) {
      return { ok: false, code: 'disabled', reason: '插件配置已禁止从 FatFish 侧新建会话' }
    }
    const binding = this.state.channel(channel) ?? {}
    let targetPath =
      String(pathArg ?? '').trim() ||
      binding.workspacePath ||
      String(this.config.workspace ?? '').trim() ||
      this.defaultWorkspacePath
    targetPath = expandHome(targetPath)
    if (!path.isAbsolute(targetPath)) targetPath = path.resolve(os.homedir(), targetPath)

    let presetId
    try {
      presetId = await this.#resolvePreset(binding.agentPreset)
    } catch (error) {
      return { ok: false, code: 'create-failed', reason: `解析 agent preset 失败：${errorMessage(error)}` }
    }

    let workspaceInfo
    try {
      workspaceInfo = await this.ensureWorkspace(targetPath)
    } catch (error) {
      return { ok: false, code: 'register-failed', reason: errorMessage(error) }
    }
    const workspace = workspaceInfo.workspace
    const sessionId = `session-${randomUUID()}`
    const agentOptions = this.#defaultAgentOptions()
    const setup = this.#agentSetup(presetId)

    try {
      const handle = await this.ctx.agents.create({
        sessionId: this.sessionId(sessionId),
        meta: {
          cwd: workspace.path,
          ...(presetId !== undefined ? { agentPreset: presetId } : {}),
        },
        ...(agentOptions !== undefined ? { agentOptions } : {}),
        ...(setup !== undefined ? { setup } : {}),
      })
      this.ownedHandles.set(sessionId, handle)
    } catch (error) {
      return { ok: false, code: 'create-failed', reason: `创建会话失败：${errorMessage(error)}` }
    }

    try {
      await workspace.attachSession(this.sessionId(sessionId))
    } catch (error) {
      this.logger.warn(`会话已创建但挂载到工作区失败：${errorMessage(error)}`)
    }

    this.state.setChannel(channel, {
      sessionId,
      workspaceId: String(workspace.id),
      workspacePath: workspace.path,
      ...(presetId !== undefined ? { agentPreset: presetId } : {}),
      title: undefined,
    })
    this.sessionChannels.set(String(sessionId), channel)
    return {
      ok: true,
      sessionId,
      workspaceId: String(workspace.id),
      workspacePath: workspace.path,
      createdWorkspace: workspaceInfo.created,
      createdDir: workspaceInfo.createdDir,
    }
  }

  /** 把频道绑定到已有会话。 */
  bindSession(channel, sessionId) {
    const id = String(sessionId ?? '').trim()
    if (!id) return { ok: false, reason: '会话 id 为空' }
    if (!/^session-/.test(id) && !id.startsWith('session_')) {
      return { ok: false, reason: `看起来不是 DSH 会话 id：${id}` }
    }
    const binding = this.state.channel(channel) ?? {}
    const workspace = this.listWorkspaces().find((item) => item.sessionIds.includes(id))
    this.state.setChannel(channel, {
      ...binding,
      sessionId: id,
      ...(workspace
        ? { workspaceId: String(workspace.id), workspacePath: workspace.path }
        : {}),
    })
    this.sessionChannels.set(id, channel)
    return { ok: true, sessionId: id }
  }

  /** 解除频道绑定（保留游标，避免重放）。 */
  unbind(channel) {
    const binding = this.state.channel(channel)
    if (!binding) return false
    this.state.setChannel(channel, {
      workspaceId: binding.workspaceId,
      workspacePath: binding.workspacePath,
      agentPreset: binding.agentPreset,
    })
    return true
  }

  /** 切换频道的工作区作用域，并清空会话绑定（防误发到旧会话）。 */
  setWorkspaceScope(channel, workspace) {
    this.state.setChannel(channel, {
      workspaceId: String(workspace.id),
      workspacePath: workspace.path,
    })
    return true
  }

  /** 接管/恢复 agent：优先 live，其次本插件持有的句柄，最后 resume。 */
  async ensureAgent(sessionId) {
    const live = this.ctx.agents.get(this.sessionId(sessionId))
    if (live !== undefined) return { ok: true, agent: live, reusedLive: true }

    const owned = this.ownedHandles.get(sessionId)
    if (owned !== undefined) return { ok: true, agent: owned.agent, reusedLive: false }

    const binding = this.channelOf(sessionId)
    const recorded = binding ? this.state.channel(binding)?.agentPreset : undefined
    let presetId
    try {
      presetId = await this.#resolvePreset(recorded)
    } catch (error) {
      return { ok: false, code: 'error', reason: `解析 agent preset 失败：${errorMessage(error)}` }
    }
    const agentOptions = this.#defaultAgentOptions()
    const setup = this.#agentSetup(presetId)
    try {
      const handle = await this.ctx.agents.resume({
        resumeSessionId: this.sessionId(sessionId),
        ...(agentOptions !== undefined ? { agentOptions } : {}),
        ...(setup !== undefined ? { setup } : {}),
      })
      this.ownedHandles.set(sessionId, handle)
      return { ok: true, agent: handle.agent, reusedLive: false }
    } catch (error) {
      if (isSessionAlreadyOwned(error)) {
        return { ok: false, code: 'locked', reason: '该会话正被另一个进程或窗口占用，请先在别处关闭它' }
      }
      return { ok: false, code: 'error', reason: `恢复会话失败：${errorMessage(error)}` }
    }
  }

  /** 页面/投影判忙：turnBoundary.openTurnStartSeq 非 null 即正在运行。 */
  isBusy(session) {
    const boundary = this.ctx.sessionProjections.stateOf(session, 'turnBoundary')
    if (boundary === undefined) return false
    return boundary.openTurnStartSeq !== null
  }

  /**
   * 向频道对应的会话投递一条用户消息。
   *
   * 没有绑定且允许新建时，会先在默认/已选工作区建会话——这就是“首次直接发消息”
   * 的引导路径，与 QQ 桥接插件的行为一致。
   */
  async send(channel, prompt) {
    const text = String(prompt ?? '').trim()
    if (!text) return { ok: false, mode: 'none', reason: '消息为空' }
    let binding = this.state.channel(channel)
    if (!binding?.sessionId) {
      if (!this.config.allow_create_session) {
        return { ok: false, mode: 'none', reason: '当前频道还没有绑定会话，且配置禁止新建' }
      }
      const created = await this.createSession(channel)
      if (!created.ok) return { ok: false, mode: 'none', reason: created.reason }
      binding = this.state.channel(channel)
      this.logger.info(`已为频道 ${channel} 新建会话 ${created.sessionId}`)
    }

    let resolution = await this.ensureAgent(binding.sessionId)
    if (!resolution.ok && looksLikeNotFound(resolution.reason)) {
      // 会话被删除/归档：清空绑定后重来一次，避免桥接永久卡死。
      this.logger.warn(`会话 ${binding.sessionId} 不存在，已清空绑定并重建`)
      this.unbind(channel)
      if (!this.config.allow_create_session) {
        return { ok: false, mode: 'none', reason: resolution.reason }
      }
      const created = await this.createSession(channel)
      if (!created.ok) return { ok: false, mode: 'none', reason: created.reason }
      resolution = await this.ensureAgent(created.sessionId)
    }
    if (!resolution.ok) return { ok: false, mode: 'none', reason: resolution.reason }

    const busy = this.isBusy(resolution.agent.session)
    this.sessionChannels.set(String(binding.sessionId), channel)
    const message = this.createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    this.rememberOwnMessage(String(message.id))
    try {
      if (busy) resolution.agent.steer(message)
      else resolution.agent.followup(message)
    } catch (error) {
      return { ok: false, mode: 'none', reason: `发送失败：${errorMessage(error)}` }
    }
    return { ok: true, mode: busy ? 'steer' : 'followup', sessionId: binding.sessionId }
  }

  /** 中断当前回合。 */
  async cancel(channel) {
    const binding = this.state.channel(channel)
    if (!binding?.sessionId) return { ok: false, reason: '当前频道还没有绑定会话' }
    const resolution = await this.ensureAgent(binding.sessionId)
    if (!resolution.ok) return { ok: false, reason: resolution.reason }
    try {
      resolution.agent.cancel({ kind: 'user' })
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: `取消失败：${errorMessage(error)}` }
    }
  }

  /** 压缩当前会话（与官方 /compact 同一条路径）。 */
  async compact(channel) {
    const binding = this.state.channel(channel)
    if (!binding?.sessionId) return { ok: false, code: 'no-target', reason: '当前频道还没有绑定会话' }
    const resolution = await this.ensureAgent(binding.sessionId)
    if (!resolution.ok) return { ok: false, code: 'agent', reason: resolution.reason }

    const presets = this.#service('agentPresets')
    const scoped = presets?.serviceFor(resolution.agent, 'compaction')
    const engine = scoped ?? this.#service('compaction')
    if (!engine) return { ok: false, code: 'unavailable', reason: '压缩服务不可用' }
    try {
      const controller = new AbortController()
      const result = await engine.compactNow(resolution.agent, controller.signal)
      if (result === null) return { ok: true, compacted: false }
      return {
        ok: true,
        compacted: true,
        shadowedItems: result.shadowedSeqs?.length ?? 0,
        shadowedTokens: result.shadowedTokenCount ?? 0,
      }
    } catch (error) {
      if (this.ManualCompactionError && error instanceof this.ManualCompactionError) {
        return { ok: false, code: error.code, reason: `压缩失败：${error.code}` }
      }
      return { ok: false, code: 'error', reason: `压缩失败：${errorMessage(error)}` }
    }
  }

  // ───────────────────────── 读取状态 ─────────────────────────

  /** 读取频道对应会话的状态快照。 */
  async status(channel) {
    const binding = this.state.channel(channel)
    if (!binding?.sessionId) return undefined
    const sessionId = binding.sessionId
    const live = this.ctx.agents.get(this.sessionId(sessionId))
    let workspace = undefined
    if (binding.workspaceId) {
      workspace = this.listWorkspaces().find((item) => item.id === binding.workspaceId)
    }
    if (!workspace && binding.workspacePath) {
      workspace = this.listWorkspaces().find(
        (item) => normalizePath(item.path) === normalizePath(binding.workspacePath),
      )
    }

    const title = await this.#titleFor(sessionId, live)
    const status = {
      sessionId,
      title,
      workspaceTitle: workspace?.title ?? '',
      workspacePath: workspace?.path ?? binding.workspacePath ?? '',
      busy: live ? this.isBusy(live.session) : false,
    }
    if (live) {
      const selection = this.#modelSelection(live)
      if (selection.model) {
        status.model = selection.provider
          ? `${selection.provider} / ${selection.model}`
          : selection.model
      }
      if (selection.reasoningEffort) status.reasoningEffort = selection.reasoningEffort
      const permissionPresets = this.#service('permissionPresets')
      if (permissionPresets) {
        try {
          status.permissionPreset = permissionPresets.current(live.session)
        } catch {
          // 投影缺失不影响状态
        }
      }
      const tokenMeter = this.#service('tokenMeter')
      if (tokenMeter) {
        try {
          const measurement = tokenMeter.measure(live.session)
          status.contextTokens = measurement?.totalTokens
          const snapshot = this.ctx.sessionProjections.snapshot(live.session, ['contextPressure'])
          status.contextWindow = snapshot?.values?.contextPressure?.contextWindow
        } catch {
          // 忽略
        }
      }
    } else {
      const selection = this.#defaultAgentOptions()
      if (selection) status.model = `${selection.provider} / ${selection.model}`
    }
    return status
  }

  /** 读取会话标题：live 投影优先，其次历史查询，最后留空。 */
  async #titleFor(sessionId, live) {
    const sessionTitle = this.#service('sessionTitle')
    if (live && sessionTitle) {
      try {
        const title = sessionTitle.get(live.session)?.title
        if (title) return title
      } catch {
        // 继续尝试历史查询
      }
    }
    const query = this.#service('sessionQuery')
    if (!query) return undefined
    try {
      const results = await query.readTitleSnapshots([sessionId])
      const value = results?.[0]?.status === 'fulfilled' ? results[0].value : undefined
      return value?.title?.title
    } catch {
      return undefined
    }
  }

  /** 当前模型选择：pending 投影 → 最后一次真实请求头 → 部署默认。 */
  #modelSelection(live) {
    if (!live) {
      const fallback = this.#defaultAgentOptions()
      return fallback ?? {}
    }
    try {
      const state = this.ctx.sessionProjections.stateOf(live.session, 'modelSelection')
      if (state?.pending) return normalizeSelection(state.pending)
    } catch {
      // 投影缺失则继续读请求头
    }
    try {
      const header = live.session.requestHeader()
      const config = header?.config
      if (config?.model) {
        return {
          provider: config.provider ?? '',
          model: String(config.model),
          ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
        }
      }
    } catch {
      // 忽略
    }
    const fallback = this.#defaultAgentOptions()
    return fallback ?? {}
  }

  /**
   * 列出所有工作区的会话（用于 /会话 列表）。
   *
   * @param {{ includeArchived?: boolean }} [options]
   * @returns {Promise<Array<{sessionId:string, workspaceId:string, workspaceTitle:string,
   *   workspacePath:string, title?:string, archived:boolean, lastActive?:number}>>}
   */
  async listSessions(options = {}) {
    const workspaces = this.listWorkspaces()
    const registry = this.ctx.workspaceRegistry
    const archivedIds = new Set((registry.archivedSessionIds ?? []).map(String))
    const query = this.#service('sessionQuery')
    const sessionController = this.#service('sessionController')

    const activity = new Map()
    if (sessionController?.list) {
      try {
        const value = await sessionController.list({}, new AbortController().signal)
        for (const item of value?.items ?? []) activity.set(String(item.sessionId), item)
      } catch {
        // 活跃时间拿不到就省略，不影响列表
      }
    }

    const all = []
    for (const workspace of workspaces) {
      for (const sessionId of workspace.sessionIds) {
        const archived = archivedIds.has(String(sessionId))
        if (archived && !options.includeArchived) continue
        all.push({
          sessionId: String(sessionId),
          workspaceId: workspace.id,
          workspaceTitle: workspace.title,
          workspacePath: workspace.path,
          archived,
        })
      }
    }
    if (!query || all.length === 0) {
      return all.map((item) => {
        const info = activity.get(item.sessionId)
        return {
          ...item,
          ...(info?.updatedAt !== undefined ? { lastActive: info.updatedAt } : {}),
        }
      })
    }

    try {
      const results = await query.readTitleSnapshots(all.map((item) => item.sessionId))
      const facetMap = new Map()
      for (const result of results ?? []) {
        if (result?.status !== 'fulfilled' || !result.value) continue
        facetMap.set(String(result.sessionId), result.value)
      }
      return all.map((item) => {
        const facet = facetMap.get(item.sessionId)
        const info = activity.get(item.sessionId)
        return {
          ...item,
          ...(facet?.title?.title ? { title: facet.title.title } : {}),
          ...(info?.updatedAt !== undefined
            ? { lastActive: info.updatedAt }
            : facet?.session?.createdAt !== undefined
              ? { lastActive: facet.session.createdAt }
              : {}),
        }
      })
    } catch {
      return all
    }
  }

  /** 切换会话模型（直通 DSH 官方 sessionController）。 */
  async selectModel(channel, provider, model) {
    const binding = this.state.channel(channel)
    if (!binding?.sessionId) return { ok: false, reason: '当前频道还没有绑定会话' }
    const controller = this.#service('sessionController')
    if (!controller?.selectModel) return { ok: false, reason: 'sessionController 不可用，无法切换模型' }
    const resolution = await this.ensureAgent(binding.sessionId)
    if (!resolution.ok) return { ok: false, reason: resolution.reason }
    try {
      await controller.selectModel({ sessionId: binding.sessionId, provider, model })
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: `切换模型失败：${errorMessage(error)}` }
    }
  }

  /** 列出可用模型（失败或服务缺失时返回空数组）。 */
  async listModels() {
    const llm = this.#service('llm')
    if (!llm) return []
    const out = []
    for (const provider of llm.listProviders()) {
      try {
        for (const model of await llm.listModels(provider.id)) {
          out.push({
            provider: provider.id,
            model: model.id,
            ...(model.name ? { name: model.name } : {}),
          })
        }
      } catch {
        // 单个供应商失败不影响其他供应商
      }
    }
    return out
  }

  /** 释放本服务持有的 AgentHandle。 */
  async dispose() {
    const handles = [...this.ownedHandles.values()]
    this.ownedHandles.clear()
    for (const handle of handles) {
      await handle.dispose().catch(() => undefined)
    }
  }
}

/** `~` 展开 + 路径规范化。 */
export function normalizePath(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return ''
  let absolute = value
  if (value === '~') absolute = os.homedir()
  else if (value.startsWith('~/') || value.startsWith('~\\')) {
    absolute = path.join(os.homedir(), value.slice(2))
  }
  absolute = path.resolve(absolute)
  if (absolute.length > 1 && (absolute.endsWith(path.sep) || absolute.endsWith('/'))) {
    absolute = absolute.slice(0, -1)
  }
  return absolute
}

/** 展开 `~`，但保留相对路径（由调用方决定基准目录）。 */
export function expandHome(raw) {
  const value = String(raw ?? '').trim()
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}
