/**
 * 全链路测试：把插件入口真的跑起来（DSH 用假服务替代），对真实 FatFish 服务端收发。
 *
 * 为了在普通 Node 进程里加载 `src/index.js`，这里把源码复制到临时目录，并放一套
 * 最小的 `@deepseek-ai/*` 桩模块——它们只承担“接口存在、返回值形状正确”，
 * 真实签名由 dsh-qqbot-bridge 的实测用法对齐。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { startFatFishServer, signup, TEST_PASSWORD } from './helpers/server.js'
import { FatFishClient } from '../src/fatfish-client.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 8000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(intervalMs)
  }
  return undefined
}

async function writeStubModules(root) {
  const modules = {
    '@deepseek-ai/schemastery': `
      class Schema { default() { return this } description() { return this } role() { return this } }
      const make = () => new Schema()
      const z = { string: make, boolean: make, number: make, object: () => new Schema() }
      export default z
    `,
    '@deepseek-ai/dsh-session': `
      export const SessionId = (id) => String(id)
    `,
    '@deepseek-ai/dsh-llm': `
      let counter = 0
      export const createUserMessage = (input) => ({ id: 'msg-' + (++counter), ...input })
    `,
    '@deepseek-ai/dsh-compaction': `
      export class ManualCompactionError extends Error {
        constructor(code) { super(String(code)); this.name = 'ManualCompactionError'; this.code = code }
      }
    `,
  }
  for (const [name, source] of Object.entries(modules)) {
    const dir = path.join(root, 'node_modules', ...name.split('/'))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.js' }))
    await fs.writeFile(path.join(dir, 'index.js'), source.trimStart())
  }
}

function fakeHost(logs) {
  const handlers = new Map()
  const live = new Map()
  const workspace = {
    id: 'w-test',
    title: '测试工作区',
    path: '',
    sessionIds: [],
    async attachSession(id) {
      if (!workspace.sessionIds.includes(String(id))) workspace.sessionIds.push(String(id))
    },
  }
  const agents = {
    async create(options) {
      const agent = {
        session: { id: String(options.sessionId), requestHeader: () => undefined },
        followup(message) {
          logs.followup.push({ sessionId: String(options.sessionId), message })
        },
        steer(message) {
          logs.steer.push({ sessionId: String(options.sessionId), message })
        },
        cancel() {
          logs.cancel.push(String(options.sessionId))
        },
      }
      live.set(String(options.sessionId), agent)
      return { agent, dispose: async () => live.delete(String(options.sessionId)) }
    },
    async resume(options) {
      return agents.create({ ...options, sessionId: options.resumeSessionId })
    },
    get(id) {
      return live.get(String(id))
    },
  }
  const registry = {
    archivedSessionIds: [],
    list() {
      return [workspace]
    },
    get(id) {
      return id === workspace.id ? workspace : undefined
    },
    async resolveByPath(workspacePath) {
      if (path.resolve(workspacePath) === path.resolve(workspace.path)) return workspace
      return undefined
    },
    async create(workspacePath) {
      workspace.path = path.resolve(workspacePath)
      return workspace
    },
  }
  const sessionProjections = {
    busy: false,
    stateOf(_session, key) {
      if (key === 'turnBoundary') return { openTurnStartSeq: this.busy ? 1 : null }
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
    tokenMeter: { measure: () => ({ totalTokens: 42 }) },
    permissionPresets: { current: () => 'workspace-write' },
  }
  const ctx = {
    agents,
    workspaceRegistry: registry,
    sessionProjections,
    logger: () => ({
      info: (...args) => logs.info.push(args.join(' ')),
      warn: (...args) => logs.warn.push(args.join(' ')),
      error: (...args) => logs.error.push(args.join(' ')),
      debug: () => {},
    }),
    get(key) {
      return services[key]
    },
    on(name, handler) {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      return () => {
        handlers.set(
          name,
          (handlers.get(name) ?? []).filter((item) => item !== handler),
        )
      }
    },
    emit(name, ...args) {
      for (const handler of handlers.get(name) ?? []) handler(...args)
    },
  }
  return { ctx, workspace, live }
}

test('插件入口全链路：FatFish 消息 → DSH 回合 → FatFish 回复', async (t) => {
  const server = await startFatFishServer()
  t.after(() => server.stop())
  await signup(server.baseUrl, 'alice')
  await signup(server.baseUrl, 'dshbot')

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fatfish-plugin-test-'))
  const workspaceDir = path.join(root, 'workspace')
  await fs.mkdir(workspaceDir, { recursive: true })
  await writeStubModules(root)
  await fs.cp(path.resolve(import.meta.dirname, '..', 'src'), path.join(root, 'src'), {
    recursive: true,
  })

  const previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(root, 'dsh-home')
  t.after(async () => {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
    await fs.rm(root, { recursive: true, force: true })
  })

  const logs = { info: [], warn: [], error: [], followup: [], steer: [], cancel: [] }
  const { ctx, workspace } = fakeHost(logs)
  workspace.path = workspaceDir

  const plugin = await import(pathToFileURL(path.join(root, 'src', 'index.js')).href)
  await plugin.apply(ctx, {
    base_url: server.baseUrl,
    username: 'dshbot',
    password: TEST_PASSWORD,
    channels: 'general',
    allowed_senders: 'alice',
    mention_required: true,
    watch_dms: true,
    poll_interval_ms: 200,
    reply_max_chars: 4000,
    workspace: workspaceDir,
  })
  t.after(async () => {
    ctx.emit('dispose')
    await sleep(300)
  })

  const alice = new FatFishClient({
    baseUrl: server.baseUrl,
    username: 'alice',
    password: TEST_PASSWORD,
  })
  await alice.login()
  await sleep(800) // 等首轮建立游标

  // alice 在公共频道 @机器人
  const before = Date.now() / 1000
  await alice.send('general', '@dshbot 你好，介绍一下你自己')

  const delivered = await waitFor(() => logs.followup[0])
  assert.ok(delivered, '插件应把消息投喂给 DSH')
  assert.deepEqual(delivered.message.content, [
    { type: 'text', text: '[alice] 你好，介绍一下你自己' },
  ])

  // 模拟 DSH 的回合：先有 user/message（用于回合归属），再有流式正文与提交
  ctx.emit('session/event', { id: delivered.sessionId }, {
    type: 'user/message',
    data: { id: delivered.message.id, source: { kind: 'user' } },
  })
  ctx.emit('agent/assistant-stream', {
    agent: { id: delivered.sessionId },
    frame: { type: 'chunk', chunk: { type: 'text-delta', text: '我是 **DSH**，' } },
  })
  ctx.emit('agent/assistant-stream', {
    agent: { id: delivered.sessionId },
    frame: { type: 'chunk', chunk: { type: 'text-delta', text: '很高兴认识你。' } },
  })
  ctx.emit('agent/assistant-stream', {
    agent: { id: delivered.sessionId },
    frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message' } },
  })

  const reply = await waitFor(async () => {
    const rows = await alice.messages('general', before)
    return rows.find(
      (row) => row.sender === 'dshbot' && row.content.includes('我是 DSH，很高兴认识你。'),
    )
  })
  assert.ok(reply, `应把 DSH 的回复发回 FatFish；实际日志：${logs.error.join(' | ')}`)
})

test('插件入口：缺凭据时离线待命，不连服务器', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fatfish-plugin-idle-'))
  await writeStubModules(root)
  await fs.cp(path.resolve(import.meta.dirname, '..', 'src'), path.join(root, 'src'), {
    recursive: true,
  })
  const previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(root, 'dsh-home')
  t.after(async () => {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
    await fs.rm(root, { recursive: true, force: true })
  })

  const logs = { info: [], warn: [], error: [], followup: [], steer: [], cancel: [] }
  const { ctx } = fakeHost(logs)
  const plugin = await import(pathToFileURL(path.join(root, 'src', 'index.js')).href)
  await plugin.apply(ctx, { base_url: 'http://127.0.0.1:1', username: '', password: '' })
  assert.ok(
    logs.warn.some((line) => line.includes('账号或密码缺失')),
    `应记录离线待命日志：${logs.warn.join(' | ')}`,
  )
})
