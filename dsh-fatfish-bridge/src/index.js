/**
 * dsh-fatfish-bridge — 插件入口（只做接线与生命周期，业务逻辑在各模块里）
 *
 * 装配链路：
 *
 *   FatFish HTTP ──▶ InboundBridge（审批/提问 → 命令 → agent）
 *                        │
 *                        ▼
 *                  DshControl（频道 ↔ DSH 会话）
 *                        │
 *                        ▼
 *              agent/assistant-stream
 *                        │
 *                        ▼
 *                OutboundRouter ──▶ FatFish 消息
 *
 * 默认“离线待命”：账号/密码缺失时不连服务器、不报错，只记一条 warn，插件仍正常挂载。
 * 这与 DSH 其他桥接插件的部署习惯一致——先装插件，再补凭据。
 */

import * as path from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { Config } from './schema.js'
import { resolveBridgeConfig, resolveDshHome } from './config.js'
import { resolveLogger } from './logger.js'
import { FatFishClient } from './fatfish-client.js'
import { BridgeState } from './state.js'
import { DshControl } from './dsh-control.js'
import { OutboundRouter } from './outbound.js'
import { Interactions } from './interactions.js'
import { createCommandDispatcher } from './commands.js'
import { InboundBridge } from './inbound.js'
import { errorMessage, markdownToPlainText, splitMessage } from './text.js'

export const name = 'dsh-fatfish-bridge'

/**
 * 必需服务：会话、工作区注册表、会话投影。
 * 其余服务（agentPresets / agentDefaultModel / sessionController / llm / tokenMeter …）
 * 按需读取，缺失时对应功能降级，不影响最基础的收发。
 */
export const inject = ['agents', 'workspaceRegistry', 'sessionProjections']

export { Config }

/**
 * Cordis 插件入口。
 */
export async function apply(ctx, config = {}) {
  const logger = resolveLogger(ctx, name)
  const resolved = resolveBridgeConfig(config)
  const dshHome = resolveDshHome()

  if (!resolved.username || !resolved.password) {
    logger.warn(
      'FatFish 账号或密码缺失，桥接处于离线待命。请在插件配置填写 username/password，' +
        `或设置环境变量 FATFISH_USERNAME/FATFISH_PASSWORD，或写入 ${path.join(dshHome, '.credentials.yaml')} 的 refs。`,
    )
    return
  }

  const client = new FatFishClient({
    baseUrl: resolved.base_url,
    username: resolved.username,
    password: resolved.password,
    logger,
  })

  const state = new BridgeState({
    file: path.join(dshHome, 'fatfish-bridge', 'state.json'),
    logger,
  })
  await state.load()

  const control = new DshControl(ctx, {
    state,
    config: resolved,
    logger,
    defaultWorkspacePath: path.join(dshHome, 'workspace', 'default'),
    sessionId: SessionId,
    createUserMessage,
    ManualCompactionError,
  })

  /** 发送一条（已拆分的）纯文本回复。 */
  const reply = async (channel, text) => {
    const plain = markdownToPlainText(text)
    const chunks = splitMessage(plain, resolved.reply_max_chars)
    for (const chunk of chunks) {
      await client.send(channel, chunk)
    }
  }

  // 回合归属：只有本桥接投喂的回合才回显到 FatFish，WebUI 自己发起的对话不镜像。
  const turnOrigin = new Map()
  const isOwnTurn = (sessionId) => turnOrigin.get(String(sessionId)) === 'fatfish'
  const offUserMessage = ctx.on('session/event', (...args) => {
    const session = args[0]
    const event = args[1]
    if (event?.type !== 'user/message' || !session?.id) return
    if (event.data?.source?.kind !== 'user') return
    const messageId = event.data.id
    if (typeof messageId !== 'string') return
    turnOrigin.set(String(session.id), control.isOwnMessage(messageId) ? 'fatfish' : 'other')
  })

  const interactions = new Interactions({
    control,
    reply,
    isOwnTurn,
    timeoutMs: resolved.interaction_timeout_seconds * 1000,
    logger,
  })
  const offInteractions = interactions.attach(ctx)

  const outbound = new OutboundRouter({
    control,
    reply,
    isOwnTurn,
    logger,
  })
  const offOutbound = outbound.attach(ctx)

  const commands = createCommandDispatcher({
    control,
    config: resolved,
    reply,
    logger,
  })

  const inbound = new InboundBridge({
    client,
    control,
    commands,
    interactions,
    state,
    config: resolved,
    reply,
    logger,
  })

  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    await inbound.stop()
    if (typeof offUserMessage === 'function') offUserMessage()
    if (typeof offInteractions === 'function') offInteractions()
    if (typeof offOutbound === 'function') offOutbound()
    await outbound.drain().catch(() => undefined)
    await state.close().catch(() => undefined)
    await control.dispose().catch((error) => logger.warn('释放 DSH 控制层失败', error))
  }
  ctx.on('dispose', () => {
    void dispose()
  })

  ctx.on('ready', () => {
    logger.info(
      `FatFish 桥接就绪：${resolved.base_url}，账号 ${resolved.username}；` +
        `监听 ${resolved.channels || '（默认频道集合）'}`,
    )
  })

  // 先登录一次给出明确诊断；失败不阻塞，后续轮询会持续重试。
  client.login().catch((error) => {
    logger.warn(`FatFish 首次登录失败：${errorMessage(error)}`)
  })

  inbound.start()
  logger.info('FatFish 桥接已挂载')
}
