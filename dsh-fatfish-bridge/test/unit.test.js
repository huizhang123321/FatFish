/**
 * 纯逻辑单元测试：不依赖 DSH 运行时，也不启动 FatFish 服务端。
 * 运行：`node test/unit.test.js`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  buildPrompt,
  formatTokens,
  markdownToPlainText,
  mentionsBot,
  parseCommand,
  shortSessionId,
  splitMessage,
  stripMention,
} from '../src/text.js'
import {
  discoverBaseUrlFromDesktop,
  parseChannelList,
  parseSenderList,
  resolveBridgeConfig,
  readCredentialRefs,
} from '../src/config.js'
import { BridgeState } from '../src/state.js'
import { createCommandDispatcher, formatStatus, normalizeCommandName } from '../src/commands.js'

test('文本：Markdown 压平成聊天可读的纯文本', () => {
  const input = [
    '## 标题',
    '',
    '这是 **加粗** 和 `行内代码`，还有 [链接](https://example.com)。',
    '',
    '```js',
    'const a = 1',
    '```',
    '',
    '> 引用一行',
  ].join('\n')
  const output = markdownToPlainText(input)
  assert.ok(!output.includes('##'))
  assert.ok(!output.includes('**'))
  assert.ok(!output.includes('`'))
  assert.ok(output.includes('这是 加粗 和 行内代码'))
  assert.ok(output.includes('链接 (https://example.com)'))
  assert.ok(output.includes('const a = 1'))
  assert.ok(output.includes('引用一行'))
})

test('文本：超长回复按段落拆分且不超上限', () => {
  const paragraph = '这是一段测试文本。'.repeat(20)
  const input = `${paragraph}\n\n${paragraph}\n\n${paragraph}`
  const chunks = splitMessage(input, 200)
  assert.ok(chunks.length >= 3)
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 200, `分片长度 ${chunk.length} 超过 200`)
  }
  assert.equal(chunks.join('\n\n').replace(/\s+/g, ''), input.replace(/\s+/g, ''))
})

test('文本：@机器人 识别与剥离', () => {
  assert.equal(mentionsBot('@dshbot 你好', 'dshbot'), true)
  assert.equal(mentionsBot('@dshbot2 你好', 'dshbot'), false)
  assert.equal(stripMention('@dshbot 你好', 'dshbot'), '你好')
  assert.equal(stripMention('@DshBot 帮我看看', 'dshbot'), '帮我看看')
})

test('文本：命令解析兼容全角斜杠', () => {
  assert.deepEqual(parseCommand('/会话 2'), { name: '会话', args: '2' })
  assert.deepEqual(parseCommand('／状态'), { name: '状态', args: '' })
  assert.equal(parseCommand('普通消息'), undefined)
})

test('文本：构造 DSH 提示词', () => {
  assert.equal(
    buildPrompt({ sender: 'alice', text: '你好', files: [], baseUrl: 'http://x', direct: true }),
    '你好',
  )
  assert.equal(
    buildPrompt({ sender: 'alice', text: '你好', files: [], baseUrl: 'http://x', direct: false }),
    '[alice] 你好',
  )
  assert.equal(
    buildPrompt({
      sender: 'alice',
      text: '',
      files: ['abc.png'],
      baseUrl: 'http://x/',
      direct: true,
    }),
    '[附件] http://x/files/abc.png',
  )
  assert.equal(shortSessionId('session-12345678-abcd'), 'session-1234…')
  assert.equal(formatTokens(1234), '1.2K')
})

test('配置：列表解析与凭据优先级', async (t) => {
  assert.deepEqual(parseChannelList('general, private:3，general\ndm:a:b'), [
    'general',
    'private:3',
    'dm:a:b',
  ])
  assert.deepEqual(parseSenderList('alice, Alice, bob'), ['alice', 'bob'])

  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fatfish-config-test-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  await fs.writeFile(
    path.join(home, '.credentials.yaml'),
    ['refs:', '  FATFISH_USERNAME: ref-user', '  FATFISH_PASSWORD: ref-pass', ''].join('\n'),
    'utf8',
  )
  const refs = readCredentialRefs(home)
  assert.equal(refs.FATFISH_USERNAME, 'ref-user')

  const fromEnv = resolveBridgeConfig(
    { username: 'cfg-user', password: 'cfg-pass', base_url: 'http://cfg:1/' },
    { env: { FATFISH_USERNAME: 'env-user', FATFISH_PASSWORD: 'env-pass' }, dshHome: home },
  )
  assert.equal(fromEnv.username, 'env-user')
  assert.equal(fromEnv.password, 'env-pass')
  assert.equal(fromEnv.credentialsFrom, 'env')

  const fromRefs = resolveBridgeConfig(
    { username: 'cfg-user', password: 'cfg-pass' },
    { env: {}, dshHome: home },
  )
  assert.equal(fromRefs.username, 'ref-user')
  assert.equal(fromRefs.password, 'ref-pass')
  assert.equal(fromRefs.credentialsFrom, 'refs')

  const fromConfig = resolveBridgeConfig(
    { base_url: 'http://127.0.0.1:5999/', username: 'cfg-user', password: 'cfg-pass' },
    { env: {}, dshHome: home },
  )
  assert.equal(fromConfig.base_url, 'http://127.0.0.1:5999')
  assert.equal(fromConfig.poll_interval_ms, 1500)
})

test('配置：从桌面端 shell-port.json 自动发现端口', async (t) => {
  const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'fatfish-appdata-'))
  t.after(() => fs.rm(appData, { recursive: true, force: true }))
  await fs.mkdir(path.join(appData, 'FatFish'), { recursive: true })
  await fs.writeFile(
    path.join(appData, 'FatFish', 'shell-port.json'),
    JSON.stringify({ port: 5100 }),
    'utf8',
  )
  assert.equal(
    discoverBaseUrlFromDesktop({ APPDATA: appData, XDG_CONFIG_HOME: undefined }),
    'http://127.0.0.1:5100',
  )
  const resolved = resolveBridgeConfig({}, { env: { APPDATA: appData }, dshHome: appData })
  assert.equal(resolved.base_url, 'http://127.0.0.1:5100')
})

test('状态：绑定、游标、去重与重启恢复', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatfish-state-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'state.json')

  const state = new BridgeState({ file })
  await state.load()
  state.setChannel('general', {
    sessionId: 'session-1',
    workspaceId: 'w1',
    workspacePath: 'C:/ws',
  })
  state.setCursor('general', 100.5)
  state.markSeen('general', 7)
  await state.flush()

  const reloaded = new BridgeState({ file })
  await reloaded.load()
  assert.equal(reloaded.channel('general').sessionId, 'session-1')
  assert.equal(reloaded.cursor('general'), 100.5)
  assert.equal(reloaded.hasSeen('general', 7), true)
  assert.equal(reloaded.hasSeen('general', 8), false)

  // 损坏文件不应让插件启动失败。
  await fs.writeFile(file, '{not json', 'utf8')
  const recovered = new BridgeState({ file })
  await recovered.load()
  assert.equal(recovered.channels().length, 0)
})

test('命令：帮助、状态、会话、切换、新建与未知命令', async () => {
  const replies = []
  const calls = []
  const control = {
    listSessions: async () => [
      {
        sessionId: 'session-aaaaaaaa-bbbb',
        workspaceId: 'w1',
        workspaceTitle: '默认工作区',
        workspacePath: 'C:/ws',
        title: '修 bug',
        lastActive: Date.now(),
        archived: false,
      },
    ],
    listWorkspaces: () => [
      { id: 'w1', title: '默认工作区', path: 'C:/ws', sessionIds: ['session-aaaaaaaa-bbbb'] },
    ],
    status: async () => ({
      sessionId: 'session-aaaaaaaa-bbbb',
      title: '修 bug',
      workspaceTitle: '默认工作区',
      workspacePath: 'C:/ws',
      model: 'deepseek-official / deepseek-flash',
      busy: false,
      contextTokens: 1000,
      contextWindow: 128000,
    }),
    binding: () => ({ sessionId: 'session-aaaaaaaa-bbbb', workspacePath: 'C:/ws' }),
    bindSession: (channel, sessionId) => {
      calls.push(['bind', sessionId])
      return { ok: true, sessionId }
    },
    setWorkspaceScope: (channel, workspace) => {
      calls.push(['scope', workspace.id])
    },
    createSession: async (channel, dir) => {
      calls.push(['create', dir])
      return { ok: true, sessionId: 'session-cccccccc-dddd', workspacePath: 'C:/ws' }
    },
    resolveWorkspace: () => undefined,
    ensureWorkspace: async () => {
      throw new Error('不应走到这里')
    },
    listModels: async () => [
      { provider: 'deepseek-official', model: 'deepseek-flash' },
      { provider: 'other', model: 'deepseek-flash' },
    ],
    selectModel: async (channel, provider, model) => {
      calls.push(['model', provider, model])
      return { ok: true }
    },
    cancel: async () => ({ ok: true }),
    compact: async () => ({ ok: true, compacted: true, shadowedItems: 2, shadowedTokens: 300 }),
  }
  const dispatcher = createCommandDispatcher({
    control,
    config: { list_page_size: 10, reply_max_chars: 4000 },
    reply: async (channel, text) => replies.push(text),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  })

  assert.equal(await dispatcher.dispatch('general', '/帮助'), true)
  assert.match(replies.pop(), /FatFish × DSH 桥接命令/)

  assert.equal(await dispatcher.dispatch('general', '/状态'), true)
  const statusReply = replies.pop()
  assert.match(statusReply, /修 bug/)
  assert.match(statusReply, /上下文/)
  replies.length = 0

  assert.equal(await dispatcher.dispatch('general', '/会话'), true)
  assert.match(replies.pop(), /1\. 修 bug/)
  assert.equal(await dispatcher.dispatch('general', '/会话 1'), true)
  assert.match(replies.pop(), /已接管会话/)
  assert.deepEqual(calls.pop(), ['bind', 'session-aaaaaaaa-bbbb'])

  assert.equal(await dispatcher.dispatch('general', '/切换'), true)
  assert.match(replies.pop(), /1\. 默认工作区/)
  assert.equal(await dispatcher.dispatch('general', '/切换 1'), true)
  assert.match(replies.pop(), /工作区已切换/)
  assert.deepEqual(calls.pop(), ['scope', 'w1'])

  assert.equal(await dispatcher.dispatch('general', '/新建'), true)
  assert.match(replies.pop(), /已新建会话/)
  assert.deepEqual(calls.pop(), ['create', undefined])

  assert.equal(await dispatcher.dispatch('general', '/模型 deepseek-official/deepseek-flash'), true)
  assert.match(replies.pop(), /已切换模型/)
  assert.deepEqual(calls.pop(), ['model', 'deepseek-official', 'deepseek-flash'])

  assert.equal(await dispatcher.dispatch('general', '/模型 deepseek-flash'), true)
  assert.match(replies.pop(), /多个供应商/)

  assert.equal(await dispatcher.dispatch('general', '/停止'), true)
  assert.match(replies.pop(), /已请求中断/)

  assert.equal(await dispatcher.dispatch('general', '/压缩'), true)
  assert.match(replies.pop(), /压缩完成/)

  assert.equal(await dispatcher.dispatch('general', '/不存在'), true)
  assert.match(replies.pop(), /未知命令/)
  assert.equal(await dispatcher.dispatch('general', '普通消息'), false)
})

test('命令：英文别名与状态渲染', () => {
  assert.equal(normalizeCommandName('HELP'), '帮助')
  assert.equal(normalizeCommandName('status'), '状态')
  assert.equal(normalizeCommandName('Switch'), '切换')
  const text = formatStatus({
    sessionId: 'session-12345678',
    title: '测试',
    workspaceTitle: 'ws',
    workspacePath: 'C:/ws',
    model: 'p / m',
    busy: true,
    contextTokens: 64000,
    contextWindow: 128000,
  })
  assert.match(text, /目标：测试/)
  assert.match(text, /状态：运行中/)
  assert.match(text, /50%/)
})
