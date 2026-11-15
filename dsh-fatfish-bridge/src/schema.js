/**
 * dsh-fatfish-bridge: 插件配置模式（schemastery）
 *
 * 单独放在一个模块里，这样不依赖 DSH 运行时的纯逻辑测试（config/text/state）
 * 不需要安装 `@deepseek-ai/schemastery` 也能跑。
 */

import z from '@deepseek-ai/schemastery'
import { CONFIG_DEFAULTS } from './config.js'

const D = CONFIG_DEFAULTS

/**
 * 插件配置模式。
 *
 * 字段说明同时出现在 DSH 的配置目录里，所以写成用户看得懂的中文。
 */
export const Config = z.object({
  base_url: z
    .string()
    .default(D.base_url)
    .description(
      'FatFish 服务地址，例如 http://127.0.0.1:5000。留空时依次尝试环境变量 FATFISH_URL、' +
        '桌面端记录的端口（%APPDATA%\\FatFish\\shell-port.json）和默认 5000 端口。',
    ),
  username: z
    .string()
    .default(D.username)
    .description(
      '桥接使用的 FatFish 账号（建议单独注册一个机器人账号，例如 dshbot）。' +
        '留空时读取环境变量 FATFISH_USERNAME 或 .credentials.yaml 的 refs.FATFISH_USERNAME。',
    ),
  password: z
    .string()
    .default(D.password)
    .role('secret')
    .description(
      '上面账号的密码。建议留空，改写到 .credentials.yaml 的 refs.FATFISH_PASSWORD，' +
        '或设置环境变量 FATFISH_PASSWORD，避免明文出现在配置里。',
    ),
  channels: z
    .string()
    .default(D.channels)
    .description(
      '要接管的频道，逗号分隔：公共频道名（general）、private:3、dm:alice:dshbot，' +
        '或 * 表示“所有公共频道 + 机器人所在的私有频道”。留空时同上但不含私聊；' +
        '要接管私聊请写 watch_dms: true 或显式列出 dm: 频道（参与者按字母序，通常是 dm:<对方>:<机器人>）。',
    ),
  allowed_senders: z
    .string()
    .default(D.allowed_senders)
    .description(
      '允许驱动 DSH 的 FatFish 用户名，逗号分隔。留空时只服务与机器人的私聊（最安全）；' +
        '在公共频道/群组里使用时必须填写，否则消息不会转发给 DSH。',
    ),
  mention_required: z
    .boolean()
    .default(D.mention_required)
    .description(
      '在公共频道/群组里，是否要求消息 @机器人 或使用 / 命令才处理。私聊不受此限制。',
    ),
  watch_dms: z.boolean().default(D.watch_dms).description('是否自动接管机器人参与的所有私聊（dm: 频道）。'),
  workspace: z
    .string()
    .default(D.workspace)
    .description(
      '新建 DSH 会话时使用的工作区路径。留空时用 $DSH_HOME/workspace/default；' +
        '频道用 /切换 选过工作区后以频道自己的选择为准。',
    ),
  poll_interval_ms: z.number().default(D.poll_interval_ms).description('轮询 FatFish 新消息的间隔（毫秒），最小 500。'),
  reply_max_chars: z.number().default(D.reply_max_chars).description('单条回复的最大字符数，超长会按段落拆成多条消息。'),
  list_page_size: z.number().default(D.list_page_size).description('/会话 与 /切换 列表的每页条数。'),
  allow_create_session: z
    .boolean()
    .default(D.allow_create_session)
    .description('允许从 FatFish 侧自动或通过 /新建 创建 DSH 会话。'),
  status_show_usage: z.boolean().default(D.status_show_usage).description('/状态 是否显示上下文用量。'),
  interaction_timeout_seconds: z
    .number()
    .default(D.interaction_timeout_seconds)
    .description('审批 / 提问等待回复的秒数，超时按拒绝或未作答处理。'),
})
