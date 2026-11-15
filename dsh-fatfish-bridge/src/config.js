/**
 * dsh-fatfish-bridge: 配置定义与解析
 *
 * 插件只保存“怎么连 FatFish、桥接哪些频道”这类接入参数，不维护 DSH 侧的
 * 模型/权限副本——那些始终读取 DSH 官方服务。
 *
 * 注意：schemastery 的配置模式放在 schema.js，避免纯逻辑测试被迫安装 DSH 依赖。
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** FatFish 默认监听端口（桌面端首次启动用的端口）。 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:5000'

/** 凭据在 DSH 凭据库（`$DSH_HOME/.credentials.yaml` 的 `refs`）中的键名。 */
export const CRED_USERNAME = 'FATFISH_USERNAME'
export const CRED_PASSWORD = 'FATFISH_PASSWORD'
export const CRED_BASE_URL = 'FATFISH_URL'

/** 插件配置的默认值（也用于测试与不经过 schemastery 的调用方）。 */
export const CONFIG_DEFAULTS = Object.freeze({
  base_url: '',
  username: '',
  password: '',
  channels: '',
  allowed_senders: '',
  mention_required: true,
  watch_dms: false,
  workspace: '',
  poll_interval_ms: 1500,
  reply_max_chars: 4000,
  list_page_size: 10,
  allow_create_session: true,
  status_show_usage: true,
  interaction_timeout_seconds: 300,
})

/** 只保留显式给出的值，避免 `undefined` 覆盖默认值。 */
function pickDefined(raw) {
  const out = {}
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (value !== undefined && value !== null) out[key] = value
    }
  }
  return out
}

/**
 * 从 `.credentials.yaml` 的 `refs:` 块读取键值。
 *
 * 只做最小解析（仅 refs 块内的 `KEY: value`），不引入 yaml 依赖——与 DSH 其他插件的
 * 读取口径一致。
 *
 * @param {string} dshHome
 * @returns {Record<string, string>}
 */
export function readCredentialRefs(dshHome) {
  const file = path.join(dshHome, '.credentials.yaml')
  if (!fs.existsSync(file)) return {}
  const out = {}
  let inRefs = false
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true
      continue
    }
    if (inRefs && /^[a-zA-Z@]/.test(line)) break
    if (!inRefs) continue
    const match = /^\s{2}([A-Z0-9_]+):\s*(.*)$/.exec(line)
    if (match) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

/** 解析 DSH 主目录，与 DSH 其他插件保持同一优先级。 */
export function resolveDshHome(explicit) {
  if (explicit) return path.resolve(explicit)
  if (process.env.DSH_HOME) return path.resolve(process.env.DSH_HOME)
  return path.resolve(os.homedir(), '.dsh')
}

/** FatFish 桌面端可能保存 shell-port.json 的目录（按平台）。 */
function fatFishUserDataDirs(env) {
  const dirs = []
  if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'FatFish'))
  dirs.push(path.join(os.homedir(), 'AppData', 'Roaming', 'FatFish'))
  dirs.push(path.join(os.homedir(), 'Library', 'Application Support', 'FatFish'))
  if (env.XDG_CONFIG_HOME) dirs.push(path.join(env.XDG_CONFIG_HOME, 'FatFish'))
  dirs.push(path.join(os.homedir(), '.config', 'FatFish'))
  return [...new Set(dirs)]
}

/**
 * 读取 FatFish 桌面端上次使用的端口。
 *
 * 桌面外壳每次启动优先复用上次端口（`shell-port.json`）。插件和它跑在同一台机器上，
 * 所以自动发现能避免“服务明明开着，插件却连 5000 端口”的常见错配。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | undefined} 形如 `http://127.0.0.1:5100` 的地址。
 */
export function discoverBaseUrlFromDesktop(env = process.env) {
  for (const dir of fatFishUserDataDirs(env)) {
    const file = path.join(dir, 'shell-port.json')
    try {
      if (!fs.existsSync(file)) continue
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const port = Number(parsed?.port)
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        return `http://127.0.0.1:${port}`
      }
    } catch {
      // 端口记录损坏不影响下一步候选
    }
  }
  return undefined
}

/** 去掉末尾斜杠，保证拼接路径时不会出现 `//`。 */
export function normalizeBaseUrl(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  return text.replace(/\/+$/, '')
}

/**
 * 把插件配置、环境变量和 DSH 凭据库合并成运行参数。
 *
 * 优先级（前者优先）：环境变量 → `.credentials.yaml` 的 refs → 插件配置。
 * 这与 DSH 其他桥接插件一致：密钥放凭据库，代码与配置里不落明文。
 *
 * @param {Record<string, unknown>} raw 插件配置。
 * @param {{ env?: NodeJS.ProcessEnv, dshHome?: string }} [options]
 */
export function resolveBridgeConfig(raw = {}, options = {}) {
  const env = options.env ?? process.env
  const dshHome = resolveDshHome(options.dshHome)
  const refs = readCredentialRefs(dshHome)
  const incoming = pickDefined(raw)
  const merged = { ...CONFIG_DEFAULTS }

  for (const key of Object.keys(CONFIG_DEFAULTS)) {
    if (incoming[key] !== undefined) merged[key] = incoming[key]
  }

  const envUsername = String(env[CRED_USERNAME] ?? '').trim()
  const envPassword = String(env[CRED_PASSWORD] ?? '').trim()
  const envBaseUrl = normalizeBaseUrl(env[CRED_BASE_URL])
  const refUsername = String(refs[CRED_USERNAME] ?? '').trim()
  const refPassword = String(refs[CRED_PASSWORD] ?? '').trim()
  const refBaseUrl = normalizeBaseUrl(refs[CRED_BASE_URL])
  const cfgUsername = String(merged.username ?? '').trim()
  const cfgPassword = String(merged.password ?? '')
  const cfgBaseUrl = normalizeBaseUrl(merged.base_url)

  const username = envUsername || refUsername || cfgUsername
  const password = envPassword || refPassword || cfgPassword
  const base_url =
    envBaseUrl || refBaseUrl || cfgBaseUrl || discoverBaseUrlFromDesktop(env) || DEFAULT_BASE_URL

  let credentialsFrom = 'missing'
  if (envUsername || envPassword) credentialsFrom = 'env'
  else if (refUsername || refPassword) credentialsFrom = 'refs'
  else if (cfgUsername || cfgPassword) credentialsFrom = 'config'

  return {
    ...merged,
    base_url,
    username,
    password,
    username_source: envUsername ? 'env' : refUsername ? 'refs' : cfgUsername ? 'config' : 'missing',
    password_source: envPassword ? 'env' : refPassword ? 'refs' : cfgPassword ? 'config' : 'missing',
    credentialsFrom,
    poll_interval_ms: clampNumber(merged.poll_interval_ms, 500, 60_000, 1500),
    reply_max_chars: Math.round(clampNumber(merged.reply_max_chars, 200, 10_000, 4000)),
    list_page_size: Math.round(clampNumber(merged.list_page_size, 1, 50, 10)),
    interaction_timeout_seconds: Math.round(
      clampNumber(merged.interaction_timeout_seconds, 10, 3600, 300),
    ),
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * 解析频道的逗号/换行/空格分隔列表。
 *
 * @param {string} text
 * @returns {string[]} 去重后的频道名；`*` 原样保留。
 */
export function parseChannelList(text) {
  const seen = new Set()
  const out = []
  for (const part of String(text ?? '').split(/[,，;；\s]+/)) {
    const item = part.trim()
    if (!item) continue
    const key = item.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/** 解析用户名列表（大小写不敏感去重，但保留原始写法）。 */
export function parseSenderList(text) {
  return parseChannelList(text)
}

/** 判断频道是否为私聊。 */
export function isDirectMessageChannel(channel) {
  return String(channel).startsWith('dm:')
}

/** 判断频道是否为私有频道/群组。 */
export function isPrivateChannel(channel) {
  return String(channel).startsWith('private:')
}

/**
 * 把一个频道标识变成适合展示的中文名称。
 *
 * @param {string} channel
 * @param {{ name?: string }} [meta]
 */
export function channelLabel(channel, meta) {
  if (meta?.name) return `${meta.name}（${channel}）`
  if (isDirectMessageChannel(channel)) {
    const users = channel.split(':').slice(1)
    return `私聊 ${users.join('、')}`
  }
  if (isPrivateChannel(channel)) return `私有频道 ${channel}`
  return `#${channel}`
}
