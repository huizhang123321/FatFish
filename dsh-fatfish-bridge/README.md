# dsh-fatfish-bridge

DeepSeek Harness × **FatFish**（本仓库的本地聊天软件）桥接插件：在 FatFish 的频道或私聊里直接驱动 DSH 会话，回复会自动回到聊天里。

它是照着 [`dsh-qqbot-bridge`](https://github.com/Jiangsubei/dsh-qqbot-bridge) 的架构改的，但传输层换成了 FatFish 的本地 HTTP 接口：**不需要 QQ 开放平台、不需要公网 webhook**，机器人就是 FatFish 里的一个普通账号。

```
FatFish 服务端 (Flask + SQLite)
        ▲   │
        │   │ GET /messages/<channel>?after=<ts>   （轮询收）
        │   ▼
   FatFishClient ──▶ InboundBridge ──▶ 命令层 / 审批 / 提问
                          │
                          ▼
                     DshControl  ── 频道 ↔ DSH 会话（steer / followup）
                          │
                          ▼
                 agent/assistant-stream
                          │
                          ▼
                   OutboundRouter ──▶ POST /send/<channel>
```

## 功能

- **频道即会话**：每个 FatFish 频道（公共频道 / 私有频道 / 群组 / 私聊）绑定一个 DSH 会话；第一次发消息时自动建会话，也可以接管已有会话。
- **远程控制**：`/会话` 选会话、`/切换` 选工作区、`/新建` 建会话、`/状态` 看模型/忙闲/上下文、`/模型` 切换、`/停止` 中断、`/压缩` 压缩。
- **step 级回复**：DSH 每个 step 的可见正文作为一条 FatFish 消息发出；过滤 reasoning 与 tool-call，不把内部思考灌进聊天。
- **审批 / 提问可远程作答**：审批回 `y` / `n`，提问回序号或自定义文本，超时 300 秒按拒绝/未作答处理。
- **只回显本桥接的回合**：在 WebUI 里手动发起的对话不会镜像到 FatFish；非受控会话的审批/提问完整交还 WebUI。
- **自动发现地址**：读取 `%APPDATA%\FatFish\shell-port.json`，FatFish 桌面端换了端口也能连上。
- **凭据不落插件配置**：优先读环境变量 / `$DSH_HOME/.credentials.yaml` 的 `refs`，其次是插件配置。
- **安全默认**：没配置 `allowed_senders` 时只服务私聊；公共频道/群组必须显式授权，且默认要求 @机器人 或 `/` 命令。

明确不做：群聊多机器人协作、主动推送、表情回应、文件发送（DSH 侧暂不注册 `send_file` 工具）、自研鉴权。

## 安装

> 要把这个插件发给别人安装？看 [INSTALL.md](INSTALL.md)（含压缩包、npm、Git 三种分发方式）。

### 前置条件

- DSH（本仓库根目录的 `dsh` 安装即可）与 Node.js ≥ 20
- FatFish 服务端已启动（桌面端打开即可；源码方式见仓库 README）

### 方式一：插件管理安装（推荐）

把本目录作为 bundle 安装到当前 profile：

```bash
dsh plugin --profile desktop add link:E:\肥鱼收集\dsh-fatfish-bridge
```

或在 DSH WebUI 的插件管理里选择本目录安装。安装后重启 DSH 进程让 Host 插件加载。

### 方式二：源码联调

```bash
cd E:\肥鱼收集\dsh-fatfish-bridge
npm test            # 纯逻辑测试，不依赖 DSH / FatFish
npm run test:live   # 起一个隔离的 FatFish 服务端做端到端测试
```

`link:` 安装时 DSH 加载的是本目录的源码（`src/index.js`），改完代码重启 DSH 即可，不需要构建。

## 准备 FatFish 机器人账号

1. 在 FatFish 里注册一个专用账号，例如 `dshbot`（不要用你自己的主账号）。
2. 如果要让它在私有频道/群组里工作，把这个账号拉进对应的频道/群组。
3. 记住密码——插件用它登录并读取消息；**不需要**在设置里生成 API 令牌（令牌只支持推送，不支持读消息）。

## 配置凭据

推荐写进 DSH 凭据库（与 DSH 其他密钥同一处，不落插件配置）：

```yaml
# %USERPROFILE%\.dsh\.credentials.yaml
refs:
  FATFISH_USERNAME: "dshbot"
  FATFISH_PASSWORD: "你的机器人账号密码"
```

解析优先级（前者优先）：

1. 环境变量 `FATFISH_USERNAME` / `FATFISH_PASSWORD` / `FATFISH_URL`
2. `.credentials.yaml` 的 `refs`
3. 插件配置里的 `username` / `password` / `base_url`

地址不填时会自动读取 FatFish 桌面端的 `shell-port.json`；再找不到就回退 `http://127.0.0.1:5000`。

## 插件配置

安装 bundle 后，插件的 loader 条目可以带这些字段（全部可选）：

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `base_url` | FatFish 地址；留空自动发现 | `''` |
| `username` | 机器人账号；建议走凭据库 | `''` |
| `password` | 机器人密码；建议走凭据库 | `''` |
| `channels` | 要接管的频道，逗号分隔；`*` = 所有公共频道 + 机器人所在的私有频道；留空同 `*`，但不含私聊。私聊频道名按参与者字母序，通常是 `dm:<对方>:<机器人>` | `''` |
| `allowed_senders` | 允许驱动 DSH 的 FatFish 用户名，逗号分隔；**留空时只服务私聊** | `''` |
| `mention_required` | 公共频道/群组里是否必须 @机器人 或 `/` 命令才处理 | `true` |
| `watch_dms` | 自动接管机器人参与的所有私聊 | `false` |
| `workspace` | 新会话的默认工作区路径；留空用 `$DSH_HOME/workspace/default` | `''` |
| `poll_interval_ms` | 轮询间隔（毫秒），最小 500 | `1500` |
| `reply_max_chars` | 单条回复最大字符数，超长按段落拆分 | `4000` |
| `list_page_size` | `/会话` `/切换` 每页条数 | `10` |
| `allow_create_session` | 是否允许从 FatFish 侧新建 DSH 会话 | `true` |
| `status_show_usage` | `/状态` 是否显示上下文用量 | `true` |
| `interaction_timeout_seconds` | 审批/提问等待秒数 | `300` |

改配置后需要重启 DSH 进程（当前版本没有做配置热更新）。

配置写在 profile 的 patch 层，例如 `~/.dsh/profiles/desktop/cordis.patch.yml`（和已有条目一起放在顶层数组里）：

```yaml
- id: dsh-fatfish-bridge
  config:
    channels: "general, private:3"
    allowed_senders: "alice"
    mention_required: true
```

凭据优先走 `.credentials.yaml`，这样配置文件里不需要出现密码。

### 配置示例：只服务私聊

```yaml
# 插件 loader 条目
config:
  channels: ""
  watch_dms: true
  # allowed_senders 留空 = 任何与机器人私聊的人都能用（适合单人使用）
```

### 配置示例：在公共频道/群组使用

```yaml
config:
  channels: "general, private:3"
  allowed_senders: "alice, bob"
  mention_required: true
```

这时只有在 `general` / `private:3` 里、由 `alice` 或 `bob` 发出、并且 @了机器人（或以 `/` 开头）的消息才会被处理。

> ⚠️ **安全提醒**：`allowed_senders` 留空时，插件拒绝处理任何公共频道/群组消息。不要为了“先跑起来”就随便把整个群的人都加进去——通过机器人可以在本机执行命令。

## 命令

| 命令 | 说明 |
| --- | --- |
| `/帮助` | 命令清单 |
| `/状态` | 目标会话、工作区、模型、思考强度、权限、忙闲、上下文用量 |
| `/会话 [序号]` | 列出所有工作区的会话；带序号则接管该会话 |
| `/切换 [序号\|路径]` | 列出/选择工作区；**切换会清空当前会话绑定** |
| `/新建 [路径]` | 在当前工作区（或指定路径）新建会话并绑定 |
| `/绑定 <会话id>` | 按 id 直接接管会话 |
| `/模型 [供应商/模型]` | 查看或切换模型；只写模型名时要求供应商唯一 |
| `/停止` | 中断当前正在生成的回复 |
| `/压缩` | 压缩当前会话历史 |
| `/下一页` `/上一页` | 列表翻页（跨页连续编号） |

英文别名也可用：`/help`、`/status`、`/sessions`、`/switch`、`/new`、`/bind`、`/model`、`/stop`、`/compact`、`/next`、`/prev`。

**审批**：收到「需要你批准一次操作」后回复 `y`（或 `是` / `允许` / `同意` / `批准` / `1` / `好` / `可以`）→ 仅本次允许；`n`（或 `否` / `拒绝` / `不同意` / `2` / `不`）→ 拒绝；`/取消` → 取消。

**提问**：选择题回复序号（多选用逗号，如 `1,3`），也可以直接回复自定义文本；`/跳过` 跳过当前题，`/取消` 放弃整次提问。

## 行为细节

- **首次启动会跳过历史**：每个频道第一次被接管时只记录最新消息的时间作为游标，不会把之前的聊天记录当成新指令。之后重启会从持久化游标继续，离线期间的消息不会漏。
- **运行中新出现的私聊**（例如刚有人私聊机器人）会从桥接启动时刻开始收，不会漏掉第一条。
- **回复按 step 发出**：DSH 的每个 step 正文单独一条消息；不做逐字流式改写（FatFish 没有官方流式消息协议，逐字编辑会刷屏）。
- **Markdown 会被压平**：标题井号、加粗星号、代码围栏标记会被去掉，保留可读内容——FatFish 的正文是纯文本。
- **回合归属**：只有本插件投喂的回合才会把回复发回 FatFish；WebUI 里自己发起的回合不镜像。
- **状态存储**：`$DSH_HOME/fatfish-bridge/state.json`（频道绑定、游标、去重 id）。原子写入，损坏会备份为 `.corrupt-<时间戳>` 后重建。
- **一个机器人账号只给一个 DSH 用**：DSH 的会话有排他写锁，第二个进程接管同一会话会如实报“被占用”，不会降级新建。

## 与 dsh-qqbot-bridge 的对应关系

| dsh-qqbot-bridge | 本插件 |
| --- | --- |
| QQ 官方 Bot API v2（WebSocket + REST） | FatFish 本地 HTTP（表单登录 + 轮询 + `/send`） |
| openid 一对一私聊 | FatFish 频道 / 私聊，一个频道一个会话 |
| `/会话` `/切换` `/新建` `/状态` `/模型` `/停止` `/压缩` | 同名命令（`/绑定` 为 FatFish 侧新增，方便直接贴会话 id） |
| QQ 流式消息 | step 级普通消息 |
| 审批/提问远端作答 | 相同，`{ prepend: true }` waterfall 抢占 |
| `app_id` / `app_secret` | `username` / `password`（建议走凭据库） |
| DSH 设置卡片 | 暂未提供，配置在 loader 条目 / 环境变量 |

## 测试

```bash
npm test
# 等价于：
node test/unit.test.js
node test/outbound-interactions.test.js
node test/dsh-control.test.js

npm run test:live
# 等价于：
node test/live-client.test.js
node test/live-inbound.test.js
node test/live-plugin.test.js
```

端到端测试会用 `MINIMOST_DATA_DIR` 起一个**隔离的临时 FatFish 服务端**（随机端口、临时数据目录），不会读写你 `%APPDATA%\FatFish` 里的真实聊天记录。`live-plugin` 还会把插件入口完整跑一遍：真实 HTTP 收发 + 假 DSH 服务，验证“消息进、回合出、回复回聊天”的整条链路。

## 故障排查

| 现象 | 检查 |
| --- | --- |
| 日志提示“账号或密码缺失，离线待命” | 配 `.credentials.yaml` 的 refs，或设置环境变量；改完重启 DSH |
| 登录失败 / 被限流 | 机器人账号密码是否正确；FatFish 同一 IP 的登录限流是 60 秒 60 次 |
| 消息不触发 | 公共频道/群组需要 `allowed_senders` + @机器人（或 `/` 命令）；私聊需要 `watch_dms: true` 或把 `dm:...` 写进 `channels` |
| 回复发不出去 | 机器人账号是否还在该频道（被移出群/频道后会 403） |
| `/状态` 没反应 | 频道是否已绑定会话；发送一条普通消息会自动创建 |
| 端口连不上 | FatFish 是否开着；`base_url` 是否写错；桌面端端口可从 `%APPDATA%\FatFish\shell-port.json` 查看 |

## License

MIT，见 [LICENSE](LICENSE)。
