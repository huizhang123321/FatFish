/**
 * dsh-fatfish-bridge: 命令层
 *
 * 聊天软件里的斜杠命令只做“远程控制面板”该做的事：选会话、看状态、切模型、停止、压缩。
 * 回执全部走普通文本消息；列表类命令支持翻页，跨页连续编号。
 *
 * 命令是纯业务逻辑，依赖全部由参数注入，便于单测（见 test/commands.test.js）。
 */

import {
  formatRelativeTime,
  formatTokens,
  parseCommand,
  shortSessionId,
  truncate,
} from './text.js'

/** 主命令（中文为准，另给英文别名）。 */
export const MAIN_COMMANDS = [
  '帮助',
  '状态',
  '会话',
  '切换',
  '新建',
  '绑定',
  '模型',
  '停止',
  '压缩',
]

/** 翻页命令：只在列表页脚提示，不列入 /帮助 的主表。 */
export const PAGING_COMMANDS = ['下一页', '上一页']

const ALIASES = new Map([
  ['help', '帮助'],
  ['status', '状态'],
  ['sessions', '会话'],
  ['session', '会话'],
  ['switch', '切换'],
  ['workspace', '切换'],
  ['new', '新建'],
  ['bind', '绑定'],
  ['model', '模型'],
  ['stop', '停止'],
  ['cancel', '停止'],
  ['compact', '压缩'],
  ['next', '下一页'],
  ['prev', '上一页'],
  ['previous', '上一页'],
])

/** 把命令名归一化为中文主命令。 */
export function normalizeCommandName(name) {
  const lower = String(name ?? '').trim().toLowerCase()
  if (!lower) return ''
  if (MAIN_COMMANDS.includes(lower) || PAGING_COMMANDS.includes(lower)) return lower
  return ALIASES.get(lower) ?? lower
}

/** 是否为本插件认识的命令。 */
export function isKnownCommand(name) {
  const normalized = normalizeCommandName(name)
  return MAIN_COMMANDS.includes(normalized) || PAGING_COMMANDS.includes(normalized)
}

/** 是否为翻页命令。 */
export function isPagingCommand(name) {
  return PAGING_COMMANDS.includes(normalizeCommandName(name))
}

/** 工作区展示：标题（路径），缺一不可时退化。 */
export function formatWorkspaceLabel(workspace) {
  if (!workspace) return '未知工作区'
  const title = String(workspace.title ?? '').trim()
  const workspacePath = String(workspace.path ?? '').trim()
  if (title && workspacePath && title !== workspacePath) return `${title}（${workspacePath}）`
  return workspacePath || title || workspace.id
}

/** 状态行渲染。 */
export function formatStatus(status, showUsage = true) {
  if (!status) {
    return '当前频道还没有绑定会话。\n直接发一条消息会自动新建；也可以先用 /会话 选择已有会话。'
  }
  const lines = []
  const title = status.title?.trim() || '（未命名会话）'
  lines.push(`目标：${title}（${shortSessionId(status.sessionId)}）`)
  lines.push(
    `工作区：${
      status.workspaceTitle
        ? `${status.workspaceTitle}${status.workspacePath ? `（${status.workspacePath}）` : ''}`
        : status.workspacePath || '（未知）'
    }`,
  )
  if (status.model) lines.push(`模型：${status.model}`)
  if (status.reasoningEffort) lines.push(`思考：${status.reasoningEffort}`)
  if (status.permissionPreset) lines.push(`权限：${status.permissionPreset}`)
  lines.push(`状态：${status.busy ? '运行中' : '空闲'}`)
  if (showUsage && Number.isFinite(status.contextTokens) && status.contextTokens > 0) {
    if (Number.isFinite(status.contextWindow) && status.contextWindow > 0) {
      const percent = Math.round((status.contextTokens / status.contextWindow) * 100)
      lines.push(
        `上下文：${formatTokens(status.contextTokens)} / ${formatTokens(status.contextWindow)}（${percent}%）`,
      )
    } else {
      lines.push(`上下文：${formatTokens(status.contextTokens)} tokens`)
    }
  }
  return lines.join('\n')
}

/** 帮助文本。 */
export function helpText() {
  return [
    'FatFish × DSH 桥接命令',
    '',
    '/状态 — 当前会话、工作区、模型、忙闲与上下文用量',
    '/会话 [序号] — 列出并接管一个已有 DSH 会话',
    '/切换 [序号|路径] — 选择工作区（会清空当前会话绑定）',
    '/新建 [路径] — 在当前工作区新建会话',
    '/绑定 <会话id> — 按 id 直接接管会话',
    '/模型 [供应商/模型] — 查看或切换模型',
    '/停止 — 中断当前正在生成的回复',
    '/压缩 — 压缩当前会话历史',
    '/帮助 — 本清单',
    '',
    '直接发消息就是和当前会话对话；未绑定时会自动新建。',
    '审批回复 y/n（或 是/否），提问回复序号或自定义文本。',
  ].join('\n')
}

/**
 * 创建命令分发器。
 *
 * @param {{
 *   control: import('./dsh-control.js').DshControl,
 *   config: ReturnType<import('./config.js').resolveBridgeConfig>,
 *   reply: (channel: string, text: string) => Promise<void>,
 *   logger: { info: Function, warn: Function, error: Function, debug?: Function },
 * }} deps
 */
export function createCommandDispatcher(deps) {
  const { control, config, reply, logger } = deps
  /** @type {Map<string, {kind: 'sessions'|'workspaces', items: any[], page: number}>} */
  const paging = new Map()

  const pageSize = () => Math.max(1, Math.round(config.list_page_size || 10))

  function paginate(channel, kind, items) {
    const size = pageSize()
    const totalPages = Math.max(1, Math.ceil(items.length / size))
    return renderPage(channel, kind, items, 1, totalPages)
  }

  function renderPage(channel, kind, items, page, totalPages) {
    const size = pageSize()
    const slice = items.slice((page - 1) * size, page * size)
    const lines = []
    for (let index = 0; index < slice.length; index += 1) {
      const number = (page - 1) * size + index + 1
      const item = slice[index]
      if (kind === 'sessions') {
        const title = truncate(item.title?.trim() || '（未命名会话）', 32)
        const time = formatRelativeTime(item.lastActive)
        const workspace = item.workspaceTitle ? ` @${truncate(item.workspaceTitle, 16)}` : ''
        lines.push(`${number}. ${title}${workspace}${time ? ` · ${time}` : ''}`)
        lines.push(`   ${shortSessionId(item.sessionId)}`)
      } else {
        const count = item.sessionIds?.length ?? 0
        lines.push(`${number}. ${truncate(formatWorkspaceLabel(item), 64)} · ${count} 个会话`)
      }
    }
    if (totalPages > 1) {
      lines.push('')
      lines.push(`第 ${page}/${totalPages} 页${page < totalPages ? '；/下一页 继续' : ''}`)
    }
    paging.set(channel, { kind, items, page })
    return lines.join('\n')
  }

  function currentItems(channel, kind) {
    const state = paging.get(channel)
    if (!state || state.kind !== kind) return undefined
    return state.items
  }

  async function listSessions(channel) {
    const sessions = await control.listSessions()
    if (sessions.length === 0) {
      await reply(channel, '还没有可接管的 DSH 会话。发一条消息会自动新建，或用 /新建。')
      return
    }
    sessions.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))
    await reply(channel, paginate(channel, 'sessions', sessions))
  }

  async function listWorkspaces(channel) {
    const workspaces = control.listWorkspaces()
    if (workspaces.length === 0) {
      await reply(channel, '还没有注册任何 DSH 工作区。可以用 /切换 <路径> 现场注册。')
      return
    }
    await reply(channel, paginate(channel, 'workspaces', workspaces))
  }

  /** 解析“序号或标题”形式的会话选择。 */
  async function pickSession(channel, arg) {
    const items = currentItems(channel, 'sessions') ?? (await control.listSessions())
    const number = Number(arg)
    if (Number.isInteger(number)) {
      if (number < 1 || number > items.length) {
        return { error: `序号超出范围（1-${items.length}）` }
      }
      return { item: items[number - 1] }
    }
    if (arg.startsWith('session-')) return { item: { sessionId: arg } }
    const needle = arg.toLowerCase()
    const matches = items.filter((item) => (item.title ?? '').toLowerCase().includes(needle))
    if (matches.length === 1) return { item: matches[0] }
    if (matches.length === 0) return { error: `没有标题包含「${arg}」的会话` }
    return { error: `有 ${matches.length} 个会话匹配「${arg}」，请改用序号` }
  }

  /** 解析“序号/标题/路径”形式的工作区选择。 */
  async function pickWorkspace(channel, arg) {
    const items = currentItems(channel, 'workspaces') ?? control.listWorkspaces()
    const number = Number(arg)
    if (Number.isInteger(number)) {
      if (number < 1 || number > items.length) {
        return { error: `序号超出范围（1-${items.length}）` }
      }
      return { item: items[number - 1] }
    }
    const resolved = control.resolveWorkspace(arg)
    if (resolved) return { item: resolved }
    // 允许直接输入一个尚未注册的路径：现场创建并注册。
    if (/[\\/]/.test(arg) || arg.startsWith('~')) {
      try {
        const info = await control.ensureWorkspace(arg)
        return { item: { id: String(info.workspace.id), title: info.workspace.title ?? '', path: info.workspace.path, sessionIds: info.workspace.sessionIds.map(String) } }
      } catch (error) {
        return { error: error.message }
      }
    }
    return { error: `没有找到工作区「${arg}」。可用 /切换 查看列表，或直接输入绝对路径。` }
  }

  /** 执行一条命令；返回是否已处理。 */
  async function dispatch(channel, text) {
    const parsed = parseCommand(text)
    if (!parsed) return false
    const name = normalizeCommandName(parsed.name)
    const args = parsed.args.trim()
    if (!isKnownCommand(name)) {
      await reply(channel, `未知命令 /${parsed.name || ''}。这条消息没有发送给会话；/帮助 查看可用命令。`)
      return true
    }

    switch (name) {
      case '帮助':
        await reply(channel, helpText())
        return true

      case '状态': {
        const status = await control.status(channel)
        await reply(channel, formatStatus(status, config.status_show_usage !== false))
        return true
      }

      case '会话': {
        if (!args) {
          await listSessions(channel)
          return true
        }
        const picked = await pickSession(channel, args)
        if (picked.error) {
          await reply(channel, `选择失败：${picked.error}`)
          return true
        }
        const result = control.bindSession(channel, picked.item.sessionId)
        if (!result.ok) {
          await reply(channel, `绑定失败：${result.reason}`)
          return true
        }
        await reply(
          channel,
          `已接管会话 ${shortSessionId(picked.item.sessionId)}${picked.item.title ? `（${picked.item.title}）` : ''}。\n之后的普通消息会发送到这个会话。`,
        )
        return true
      }

      case '切换': {
        if (!args) {
          await listWorkspaces(channel)
          return true
        }
        const picked = await pickWorkspace(channel, args)
        if (picked.error) {
          await reply(channel, `切换失败：${picked.error}`)
          return true
        }
        control.setWorkspaceScope(channel, picked.item)
        await reply(
          channel,
          `工作区已切换：${formatWorkspaceLabel(picked.item)}\n当前会话绑定已清空；下一条消息会在这个工作区新建会话，或用 /会话 接管已有会话。`,
        )
        return true
      }

      case '新建': {
        const created = await control.createSession(channel, args || undefined)
        if (!created.ok) {
          await reply(channel, `新建失败：${created.reason}`)
          return true
        }
        await reply(
          channel,
          `已新建会话 ${shortSessionId(created.sessionId)}。\n工作区：${created.workspacePath}${created.createdWorkspace ? '（新注册）' : ''}\n下一条消息会进入这个会话。`,
        )
        return true
      }

      case '绑定': {
        if (!args) {
          await reply(channel, '用法：/绑定 <会话 id>，id 形如 session-xxxxxxxx-…。')
          return true
        }
        const result = control.bindSession(channel, args)
        if (!result.ok) {
          await reply(channel, `绑定失败：${result.reason}`)
          return true
        }
        await reply(channel, `已接管会话 ${shortSessionId(result.sessionId)}。`)
        return true
      }

      case '模型': {
        if (!args) {
          const status = await control.status(channel)
          const current = status?.model ? `当前模型：${status.model}` : '当前会话还没有可读的模型信息。'
          await reply(
            channel,
            `${current}\n切换用法：/模型 <供应商>/<模型>，或 /模型 <模型名>（模型名唯一时自动匹配）。`,
          )
          return true
        }
        const binding = control.binding(channel)
        if (!binding?.sessionId) {
          await reply(channel, '当前频道还没有绑定会话，先发一条消息或用 /会话 选择。')
          return true
        }
        const models = await control.listModels()
        let provider = ''
        let model = args
        const slash = args.indexOf('/')
        if (slash > 0) {
          provider = args.slice(0, slash).trim()
          model = args.slice(slash + 1).trim()
        }
        if (!provider) {
          const matches = models.filter((item) => item.model === args)
          const uniqueProviders = [...new Set(matches.map((item) => item.provider))]
          if (uniqueProviders.length === 1) {
            provider = uniqueProviders[0]
          } else if (uniqueProviders.length > 1) {
            await reply(
              channel,
              `模型「${args}」存在多个供应商：${uniqueProviders.join('、')}。请用 /模型 <供应商>/<模型>。`,
            )
            return true
          } else {
            const status = await control.status(channel)
            const currentProvider = status?.model?.includes(' / ')
              ? status.model.split(' / ')[0].trim()
              : ''
            if (!currentProvider) {
              await reply(channel, `没有找到模型「${args}」。可用 /模型 查看当前模型，或写成 <供应商>/<模型>。`)
              return true
            }
            provider = currentProvider
          }
        }
        const result = await control.selectModel(channel, provider, model)
        if (!result.ok) {
          await reply(channel, `切换模型失败：${result.reason}`)
          return true
        }
        await reply(channel, `已切换模型：${provider} / ${model}。`)
        return true
      }

      case '停止': {
        const result = await control.cancel(channel)
        await reply(channel, result.ok ? '已请求中断当前回合。' : `停止失败：${result.reason}`)
        return true
      }

      case '压缩': {
        await reply(channel, '正在压缩当前会话…')
        const result = await control.compact(channel)
        if (!result.ok) {
          await reply(channel, `压缩失败：${result.reason}`)
        } else if (!result.compacted) {
          await reply(channel, '当前会话无需压缩。')
        } else {
          await reply(
            channel,
            `压缩完成：收起 ${result.shadowedItems} 条历史，约 ${formatTokens(result.shadowedTokens)} tokens。`,
          )
        }
        return true
      }

      case '下一页':
      case '上一页': {
        const state = paging.get(channel)
        if (!state) {
          await reply(channel, '当前没有可翻页的列表。先发送 /会话 或 /切换。')
          return true
        }
        const totalPages = Math.max(1, Math.ceil(state.items.length / pageSize()))
        const page = name === '下一页' ? state.page + 1 : state.page - 1
        if (page < 1) {
          await reply(channel, '已经是第一页。')
          return true
        }
        if (page > totalPages) {
          await reply(channel, '已经是最后一页。')
          return true
        }
        state.page = page
        await reply(channel, renderPage(channel, state.kind, state.items, page, totalPages))
        return true
      }

      default:
        await reply(channel, '未知命令。/帮助 查看可用命令。')
        return true
    }
  }

  return { dispatch, paging }
}
