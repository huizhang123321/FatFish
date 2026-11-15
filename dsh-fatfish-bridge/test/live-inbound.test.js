/**
 * 端到端契约测试：入站轮询 + 授权 + @提及 + 命令 + 回复，全部对真实 FatFish 服务端。
 * DSH 用假控制层替代（DSH 运行时不在测试进程里）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { startFatFishServer, signup, TEST_PASSWORD } from './helpers/server.js'
import { FatFishClient } from '../src/fatfish-client.js'
import { BridgeState } from '../src/state.js'
import { InboundBridge } from '../src/inbound.js'
import { createCommandDispatcher } from '../src/commands.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 6000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(intervalMs)
  }
  return undefined
}

test('入站桥接：授权、@提及、命令与私聊', async (t) => {
  const server = await startFatFishServer()
  t.after(() => server.stop())
  await signup(server.baseUrl, 'alice')
  await signup(server.baseUrl, 'dshbot')

  const bot = new FatFishClient({
    baseUrl: server.baseUrl,
    username: 'dshbot',
    password: TEST_PASSWORD,
  })
  const alice = new FatFishClient({
    baseUrl: server.baseUrl,
    username: 'alice',
    password: TEST_PASSWORD,
  })
  await bot.login()
  await alice.login()

  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatfish-inbound-state-'))
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  const state = new BridgeState({ file: path.join(stateDir, 'state.json') })
  await state.load()

  const prompts = []
  const control = {
    async send(channel, prompt) {
      prompts.push({ channel, prompt })
      return { ok: true, mode: 'followup', sessionId: 'session-test' }
    },
    channelOf: () => 'general',
    binding: () => undefined,
    status: async () => undefined,
    listSessions: async () => [],
    listWorkspaces: () => [],
    resolveWorkspace: () => undefined,
    ensureWorkspace: async () => {
      throw new Error('unused')
    },
    createSession: async () => ({ ok: false, reason: 'unused' }),
    bindSession: () => ({ ok: false }),
    setWorkspaceScope: () => {},
    listModels: async () => [],
    selectModel: async () => ({ ok: false }),
    cancel: async () => ({ ok: true }),
    compact: async () => ({ ok: false, reason: 'unused' }),
  }

  const config = {
    base_url: server.baseUrl,
    username: 'dshbot',
    password: TEST_PASSWORD,
    channels: 'general',
    allowed_senders: 'alice',
    mention_required: true,
    watch_dms: true,
    poll_interval_ms: 200,
    reply_max_chars: 4000,
    list_page_size: 10,
    allow_create_session: true,
    status_show_usage: true,
  }

  const answered = []
  let approvalPending = false
  const interactions = {
    approval: {
      hasPending: () => approvalPending,
      handle: (channel, text) => {
        answered.push({ channel, text })
        approvalPending = false
        return true
      },
    },
    question: { hasPending: () => false, handle: () => false },
  }
  const reply = (channel, text) => bot.send(channel, text)
  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  const commands = createCommandDispatcher({ control, config, reply, logger })
  const inbound = new InboundBridge({
    client: bot,
    control,
    commands,
    interactions,
    state,
    config,
    reply,
    logger,
  })

  inbound.start()
  t.after(() => inbound.stop())
  await sleep(600) // 等首轮刷新频道 + 建立游标

  // 1) @机器人 + 授权用户 → 进入 DSH
  await alice.send('general', '@dshbot 你好，帮我看看')
  const first = await waitFor(() => (prompts.length >= 1 ? prompts[0] : undefined))
  assert.ok(first, '应把消息转发给 DSH')
  assert.equal(first.channel, 'general')
  assert.equal(first.prompt, '[alice] 你好，帮我看看')

  // 2) 命令：回执走普通消息，不进入 DSH
  const beforeHelp = Date.now() / 1000
  await alice.send('general', '/帮助')
  const helpReply = await waitFor(async () => {
    const rows = await alice.messages('general', beforeHelp)
    return rows.find((row) => row.sender === 'dshbot' && row.content.includes('FatFish × DSH'))
  })
  assert.ok(helpReply, '命令回执应发回频道')
  assert.equal(prompts.length, 1, '命令不应转发给 DSH')

  // 3) 未 @机器人且不是命令 → 不处理
  await alice.send('general', '这是一条普通聊天')
  await sleep(700)
  assert.equal(prompts.length, 1, '未 @ 的公共频道消息不应触发 DSH')

  // 3.5) 审批待决时，裸回复 y（没有 @）也必须被交互层消费
  approvalPending = true
  await alice.send('general', 'y')
  const answeredCall = await waitFor(() => answered[0])
  assert.ok(answeredCall, '审批待决消息不应被 @ 要求挡住')
  assert.equal(answeredCall.text, 'y')
  assert.equal(prompts.length, 1, '审批回复不应转发给 DSH')

  // 4) 私聊：不需要 @，正文不加前缀
  await alice.send('dm:alice:dshbot', '私聊你好')
  await inbound.refreshChannels() // 生产环境每 10 秒自动刷新一次；测试里立即刷新
  const dmCall = await waitFor(() =>
    prompts.find((item) => item.channel === 'dm:alice:dshbot'),
  )
  assert.ok(dmCall, '私聊消息应转发给 DSH')
  assert.equal(dmCall.prompt, '私聊你好')

  // 5) 游标持久化：重载状态后游标应前进
  await state.flush()
  const reloaded = new BridgeState({ file: state.file })
  await reloaded.load()
  assert.ok(reloaded.cursor('general') > 0)
})
