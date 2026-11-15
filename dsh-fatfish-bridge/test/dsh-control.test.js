/**
 * DSH 控制层单元测试：用假 Cordis 服务验证“频道 ↔ 会话”的装配逻辑。
 *
 * 这里不 import 任何 DSH 包：SessionId / createUserMessage 由入口注入，
 * 本测试注入等价的最小实现，从而能在没有 DSH 运行时的环境里跑。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { BridgeState } from '../src/state.js'
import { DshControl } from '../src/dsh-control.js'
import { resolveBridgeConfig } from '../src/config.js'

function fakeWorkspace(registry, workspacePath, title = '') {
  const workspace = {
    id: `w-${registry.map.size + 1}`,
    path: workspacePath,
    title,
    sessionIds: [],
    async attachSession(id) {
      if (!workspace.sessionIds.includes(String(id))) workspace.sessionIds.push(String(id))
    },
  }
  registry.map.set(workspace.id, workspace)
  return workspace
}

function createFakes() {
  const registry = {
    map: new Map(),
    archivedSessionIds: [],
    list() {
      return [...this.map.values()]
    },
    get(id) {
      return this.map.get(String(id))
    },
    async resolveByPath(workspacePath) {
      return this.list().find((workspace) => path.resolve(workspace.path) === path.resolve(workspacePath))
    },
    async create(workspacePath) {
      return fakeWorkspace(this, workspacePath)
    },
  }

  const calls = { created: [], resumed: [], followup: [], steer: [], cancel: [] }
  const live = new Map()
  const makeAgent = (sessionId) => ({
    session: {
      id: String(sessionId),
      requestHeader() {
        return { config: { provider: 'deepseek-official', model: 'deepseek-flash' } }
      },
    },
    followup(message) {
      calls.followup.push({ sessionId: String(sessionId), message })
    },
    steer(message) {
      calls.steer.push({ sessionId: String(sessionId), message })
    },
    cancel(reason) {
      calls.cancel.push({ sessionId: String(sessionId), reason })
    },
  })
  const agents = {
    map: live,
    async create(options) {
      calls.created.push(options)
      const agent = makeAgent(options.sessionId)
      live.set(String(options.sessionId), agent)
      return { agent, dispose: async () => live.delete(String(options.sessionId)) }
    },
    async resume(options) {
      calls.resumed.push(options)
      const agent = makeAgent(options.resumeSessionId)
      live.set(String(options.resumeSessionId), agent)
      return { agent, dispose: async () => live.delete(String(options.resumeSessionId)) }
    },
    get(id) {
      return live.get(String(id))
    },
  }

  const sessionProjections = {
    busy: false,
    stateOf(_session, key) {
      if (key === 'turnBoundary') {
        return { openTurnStartSeq: this.busy ? 1 : null }
      }
      return undefined
    },
    snapshot() {
      return { values: { contextPressure: { contextWindow: 128000 } } }
    },
  }

  const services = {
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    },
    sessionController: {
      async selectModel(request) {
        calls.selectedModel = request
      },
      async list() {
        return { items: [] }
      },
    },
    tokenMeter: { measure: () => ({ totalTokens: 1000 }) },
    permissionPresets: { current: () => 'workspace-write' },
    llm: {
      listProviders: () => [{ id: 'deepseek-official' }],
      async listModels() {
        return [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }]
      },
    },
  }

  const ctx = {
    agents,
    workspaceRegistry: registry,
    sessionProjections,
    get(key) {
      return services[key]
    },
  }

  return { ctx, registry, agents, sessionProjections, services, calls }
}

async function makeControl(overrides = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fatfish-control-test-'))
  const workspaceDir = path.join(home, 'workspace', 'demo')
  await fs.mkdir(workspaceDir, { recursive: true })
  const state = new BridgeState({ file: path.join(home, 'fatfish-bridge', 'state.json') })
  await state.load()
  const config = resolveBridgeConfig(
    { workspace: workspaceDir, allow_create_session: true, ...overrides },
    { env: {}, dshHome: home },
  )
  const fakes = createFakes()
  const control = new DshControl(fakes.ctx, {
    state,
    config,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    defaultWorkspacePath: path.join(home, 'workspace', 'default'),
    sessionId: (id) => String(id),
    createUserMessage: (input) => ({ id: `msg-${Math.random()}`, ...input }),
  })
  return { control, state, fakes, home, workspaceDir }
}

test('控制层：首次发消息自动建会话、绑定并投喂', async (t) => {
  const { control, state, fakes, home, workspaceDir } = await makeControl()
  t.after(() => fs.rm(home, { recursive: true, force: true }))

  const result = await control.send('general', '你好')
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'followup')
  assert.ok(result.sessionId?.startsWith('session-'))

  const binding = state.channel('general')
  assert.equal(binding.sessionId, result.sessionId)
  assert.equal(binding.workspacePath, workspaceDir)

  assert.equal(fakes.calls.created.length, 1)
  const created = fakes.calls.created[0]
  assert.equal(created.meta.cwd, workspaceDir)
  assert.equal(created.agentOptions.provider, 'deepseek-official')

  // 工作区挂载
  const workspace = fakes.registry.list().find((item) => item.id === binding.workspaceId)
  assert.ok(workspace.sessionIds.includes(result.sessionId))

  // 消息投喂 + 回合归属
  assert.equal(fakes.calls.followup.length, 1)
  const message = fakes.calls.followup[0].message
  assert.deepEqual(message.content, [{ type: 'text', text: '你好' }])
  assert.equal(control.isOwnMessage(message.id), true)
  assert.equal(control.isOwnMessage('someone-else'), false)
  assert.equal(control.channelOf(result.sessionId), 'general')

  // /切换 清空绑定后，进行中的回合仍应知道回复该回哪个频道
  control.unbind('general')
  assert.equal(control.binding('general').sessionId, undefined)
  assert.equal(control.channelOf(result.sessionId), 'general')
})

test('控制层：忙时 steer，闲时 followup', async (t) => {
  const { control, fakes, home } = await makeControl()
  t.after(() => fs.rm(home, { recursive: true, force: true }))

  const first = await control.send('general', '第一条')
  assert.equal(fakes.calls.followup.length, 1)
  assert.equal(fakes.calls.steer.length, 0)

  fakes.sessionProjections.busy = true
  const second = await control.send('general', '第二条')
  assert.equal(second.mode, 'steer')
  assert.equal(fakes.calls.steer.length, 1)
  assert.equal(fakes.calls.steer[0].sessionId, first.sessionId)

  fakes.sessionProjections.busy = false
  const third = await control.send('general', '第三条')
  assert.equal(third.mode, 'followup')
  assert.equal(fakes.calls.followup.length, 2)
})

test('控制层：live agent 缺席时 resume，并复用持久化绑定', async (t) => {
  const { control, state, fakes, home } = await makeControl()
  t.after(() => fs.rm(home, { recursive: true, force: true }))

  const first = await control.send('general', '先建会话')
  fakes.agents.map.clear() // 模拟 DSH 重启：live agent 消失
  control.ownedHandles.clear() // 插件私有句柄也随进程重启丢失

  const second = await control.send('general', '重启后')
  assert.equal(second.ok, true)
  assert.equal(fakes.calls.resumed.length, 1)
  assert.equal(String(fakes.calls.resumed[0].resumeSessionId), first.sessionId)
  assert.equal(state.channel('general').sessionId, first.sessionId)
})

test('控制层：排他锁冲突如实回执，不降级新建', async (t) => {
  const { control, fakes, home } = await makeControl()
  t.after(() => fs.rm(home, { recursive: true, force: true }))

  const first = await control.send('general', '先建会话')
  fakes.agents.map.clear()
  control.ownedHandles.clear()
  fakes.agents.resume = async () => {
    const error = new Error('session is owned')
    error.name = 'SessionAlreadyOwnedError'
    throw error
  }

  const result = await control.send('general', '再来一条')
  assert.equal(result.ok, false)
  assert.match(result.reason, /占用/)
  assert.equal(fakes.calls.created.length, 1, '不得降级新建第二个会话')
  assert.ok(first.sessionId)
})

test('控制层：/切换 与 /新建 的工作区作用域', async (t) => {
  const { control, state, fakes, home } = await makeControl()
  t.after(() => fs.rm(home, { recursive: true, force: true }))

  const otherDir = path.join(home, 'another-project')
  const workspace = await control.ensureWorkspace(otherDir)
  assert.equal(workspace.created, true)

  control.setWorkspaceScope('general', workspace.workspace)
  assert.equal(state.channel('general').workspacePath, path.resolve(otherDir))
  assert.equal(state.channel('general').sessionId, undefined)

  const created = await control.createSession('general')
  assert.equal(created.ok, true)
  assert.equal(created.workspacePath, path.resolve(otherDir))
  assert.equal(state.channel('general').sessionId, created.sessionId)
})

test('控制层：状态、模型列表与取消', async (t) => {
  const { control, fakes, home } = await makeControl()
  t.after(() => fs.rm(home, { recursive: true, force: true }))

  const sent = await control.send('general', '你好')
  assert.ok(sent.sessionId)

  const status = await control.status('general')
  assert.equal(status.sessionId, sent.sessionId)
  assert.equal(status.model, 'deepseek-official / deepseek-flash')
  assert.equal(status.permissionPreset, 'workspace-write')
  assert.equal(status.contextTokens, 1000)
  assert.equal(status.contextWindow, 128000)
  assert.equal(status.busy, false)

  const models = await control.listModels()
  assert.deepEqual(models, [
    { provider: 'deepseek-official', model: 'deepseek-flash', name: 'DeepSeek Flash' },
  ])

  const selected = await control.selectModel('general', 'deepseek-official', 'deepseek-flash')
  assert.equal(selected.ok, true)

  const cancelled = await control.cancel('general')
  assert.equal(cancelled.ok, true)
  assert.equal(fakes.calls.cancel.length, 1)
})

test('控制层：未绑定频道时 /状态 返回 undefined', async (t) => {
  const { control, home } = await makeControl()
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  assert.equal(await control.status('empty-channel'), undefined)
})
