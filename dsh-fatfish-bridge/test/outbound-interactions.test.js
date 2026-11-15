/**
 * 出站路由与审批/提问的单元测试：用假 Cordis 上下文模拟事件发射，
 * 不依赖 DSH 运行时，也不需要网络。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { OutboundRouter } from '../src/outbound.js'
import { Interactions } from '../src/interactions.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeContext() {
  const handlers = new Map()
  return {
    handlers,
    on(name, handler) {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      return () => {
        const current = handlers.get(name) ?? []
        handlers.set(
          name,
          current.filter((item) => item !== handler),
        )
      }
    },
    emit(name, ...args) {
      for (const handler of handlers.get(name) ?? []) handler(...args)
    },
  }
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await sleep(20)
  }
  return undefined
}

test('出站：只在 step 提交时发一条，过滤 reasoning 与非本桥接回合', async () => {
  const ctx = fakeContext()
  const replies = []
  const control = { channelOf: (sessionId) => (sessionId === 'session-a' ? 'general' : undefined) }
  let own = true
  const router = new OutboundRouter({
    control,
    reply: async (channel, text) => replies.push([channel, text]),
    isOwnTurn: () => own,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  })
  router.attach(ctx)

  ctx.emit('agent/assistant-stream', {
    agent: { id: 'session-a' },
    frame: { type: 'chunk', chunk: { type: 'text-delta', text: '你' } },
  })
  ctx.emit('agent/assistant-stream', {
    agent: { id: 'session-a' },
    frame: { type: 'chunk', chunk: { type: 'text-delta', text: '好' } },
  })
  ctx.emit('agent/assistant-stream', {
    agent: { id: 'session-a' },
    frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '内部思考' } },
  })
  await router.drain()
  assert.equal(replies.length, 0, '增量阶段不应发消息')

  ctx.emit('agent/assistant-stream', {
    agent: { id: 'session-a' },
    frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message' } },
  })
  await router.drain()
  assert.deepEqual(replies, [['general', '你好']])

  // 第二个 step
  ctx.emit('agent/assistant-stream', {
    agent: { id: 'session-a' },
    frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message' } },
  })
  await router.drain()
  assert.equal(replies.length, 1, '空段不应发消息')

  // 非本桥接回合：WebUI 自己发起的对话不回显
  own = false
  ctx.emit('agent/assistant-stream', {
    agent: { id: 'session-a' },
    frame: { type: 'chunk', chunk: { type: 'text-delta', text: '不应发出' } },
  })
  ctx.emit('agent/assistant-stream', {
    agent: { id: 'session-a' },
    frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message' } },
  })
  await router.drain()
  assert.equal(replies.length, 1)

  // turn/end 兜底：无 attempt-end 帧时也能收尾
  own = true
  ctx.emit('agent/assistant-stream', {
    agent: { id: 'session-a' },
    frame: { type: 'chunk', chunk: { type: 'text-delta', text: '兜底内容' } },
  })
  ctx.emit('session/event', { id: 'session-a' }, { type: 'turn/end', data: { turn: 1 } })
  await router.drain()
  assert.deepEqual(replies[1], ['general', '兜底内容'])
})

test('审批：受控回合被远端接管，回复 y 允许一次', async () => {
  const ctx = fakeContext()
  const replies = []
  const control = { channelOf: () => 'general' }
  const interactions = new Interactions({
    control,
    reply: async (channel, text) => replies.push(text),
    isOwnTurn: () => true,
    timeoutMs: 2000,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  })
  interactions.attach(ctx)

  let outcome
  const pending = Promise.resolve(
    ctx.handlers.get('approval/request')[0](
      { agent: { session: { id: 'session-a' } }, toolName: 'pwsh', reason: '执行命令' },
      () => 'next',
    ),
  ).then((value) => {
    outcome = value
  })

  assert.ok(await waitFor(() => replies.length > 0), '应发出审批提示')
  assert.match(replies[0], /需要你批准/)
  assert.match(replies[0], /pwsh/)
  assert.ok(await waitFor(() => interactions.approval.hasPending('general')), '应进入待决态')

  assert.equal(interactions.approval.handle('general', 'y'), true)
  await pending
  assert.equal(outcome, 'allowed-once')
})

test('审批：非受控会话交还 WebUI（next）', async () => {
  const ctx = fakeContext()
  const interactions = new Interactions({
    control: { channelOf: () => undefined },
    reply: async () => {},
    isOwnTurn: () => true,
    timeoutMs: 1000,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  })
  interactions.attach(ctx)
  const outcome = await ctx.handlers.get('approval/request')[0](
    { agent: { session: { id: 'session-x' } }, toolName: 'x' },
    () => 'delegated',
  )
  assert.equal(outcome, 'delegated')
})

test('提问：序号作答映射为选项 label', async () => {
  const ctx = fakeContext()
  const replies = []
  const interactions = new Interactions({
    control: { channelOf: () => 'general' },
    reply: async (channel, text) => replies.push(text),
    isOwnTurn: () => true,
    timeoutMs: 2000,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  })
  interactions.attach(ctx)

  let result
  const pending = Promise.resolve(
    ctx.handlers.get('user-questions/request')[0](
      {
        agent: { session: { id: 'session-a' } },
        questions: [
          {
            id: 'q1',
            header: '选择',
            question: '用哪个方案？',
            options: [{ label: '方案 A' }, { label: '方案 B' }],
            multiSelect: false,
          },
        ],
      },
      () => 'next',
    ),
  ).then((value) => {
    result = value
  })

  assert.ok(await waitFor(() => replies.length > 0), '应发出提问')
  assert.match(replies[0], /1\. 方案 A/)
  assert.ok(await waitFor(() => interactions.question.hasPending('general')), '应进入待决态')
  assert.equal(interactions.question.handle('general', '2'), true)
  await pending
  assert.deepEqual(result, { answers: [{ id: 'q1', selected: ['方案 B'] }] })
})
