/**
 * 端到端契约测试：对着一个真正运行的 FatFish 服务端，验证插件最底层的传输。
 *
 * 覆盖：表单登录 + CSRF + 会话 Cookie、按游标读取消息、以机器人身份发送回复。
 * 运行：`npm run test:live`（需要仓库根目录的 .venv）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  startFatFishServer,
  signup,
  sendWithCookie,
  readWithCookie,
  TEST_PASSWORD,
} from './helpers/server.js'
import { FatFishClient } from '../src/fatfish-client.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 5000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(intervalMs)
  }
  return undefined
}

test('FatFishClient：登录、轮询、发送闭环', async (t) => {
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

  assert.equal(await bot.login(), 'dshbot')
  assert.equal(await alice.login(), 'alice')

  const channels = await bot.channels()
  assert.ok(channels.includes('general'), '应能列出公共频道')

  const baseline = (await bot.latestMessage('general'))?.ts ?? 0
  const text = `桥接入站测试 ${Date.now()}`
  await alice.send('general', text)

  const inbound = await waitFor(async () => {
    const rows = await bot.messages('general', baseline)
    return rows.find((row) => row.content === text && row.sender === 'alice')
  })
  assert.ok(inbound, '机器人应轮询到 alice 的新消息')
  assert.equal(inbound.deleted, 0)

  const reply = `收到：${inbound.content}`
  await bot.send('general', reply)

  const outbound = await waitFor(async () => {
    const rows = await alice.messages('general', inbound.ts)
    return rows.find((row) => row.content === reply && row.sender === 'dshbot')
  })
  assert.ok(outbound, 'alice 应能看到机器人的回复')

  // 再次登录应能复用同一客户端（幂等）
  assert.equal(await bot.login(), 'dshbot')
})

test('FatFishClient：私聊频道可读可写', async (t) => {
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

  const dm = 'dm:alice:dshbot'
  const text = `私聊测试 ${Date.now()}`
  await alice.send(dm, text)

  const inbound = await waitFor(async () => {
    const rows = await bot.messages(dm, 0)
    return rows.find((row) => row.content === text)
  })
  assert.ok(inbound, '机器人应能读到私聊消息')

  await bot.send(dm, '私聊回复')
  const outbound = await waitFor(async () => {
    const rows = await alice.messages(dm, inbound.ts)
    return rows.find((row) => row.content === '私聊回复')
  })
  assert.ok(outbound, 'alice 应能看到私聊回复')
})

test('FatFishClient：未登录时能自动登录并读取', async (t) => {
  const server = await startFatFishServer()
  t.after(() => server.stop())

  await signup(server.baseUrl, 'alice')
  await signup(server.baseUrl, 'dshbot')
  const { cookie } = await signup(server.baseUrl, 'carol')

  const bot = new FatFishClient({
    baseUrl: server.baseUrl,
    username: 'dshbot',
    password: TEST_PASSWORD,
  })
  // 不显式 login，直接读取：request() 内部应自动登录。
  const channels = await bot.channels()
  assert.ok(channels.includes('general'))

  const text = `懒登录测试 ${Date.now()}`
  await sendWithCookie(server.baseUrl, cookie, 'general', text)
  const rows = await readWithCookie(server.baseUrl, cookie, 'general')
  assert.ok(rows.some((row) => row.content === text))
})
