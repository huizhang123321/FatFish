# 阶段1：Minimost 架构阅读与改造计划（决策确认稿）

> 依据：GitHub 仓库 SamuelDonovan/minimost，main 分支 commit `5c7f463`（2026-08-18，MIT 许可）。
> 本文所有架构结论均来自对仓库源码/官方文档的实际阅读，非推测；个别未逐行核实处已标注 ⚠️。
> 本阶段只输出计划，不写实现代码。

## 已确认决策（2026-11-12）

| 决策点 | 结论 |
|---|---|
| 前端方案 | **重写全新桌面 UI**（不在 Minimost 旧前端上扩展；旧前端保留在仓库中不删除） |
| 后端架构 | **同一 Flask 进程内扩展**：新增 social 蓝图 + 扩展现有 chat 蓝图 |
| 好友申请 SSE 实时通知 | **实现**（需求明确要求） |
| 群组角色 | **owner / admin / member 三级** |
| 上传大小限制 | **保持现状**（单文件 25MB、头像 5MB，settings.json 可配） |
| 目标平台 | Windows 10/11 x64；macOS 本期不做（默认假设） |
| 打包方案 | Electron + PyInstaller 后端（默认假设，未否决） |

---

## 一、现状架构盘点（已核实）

### 1.1 代码结构

```
minimost/
├── src/minimost/
│   ├── __init__.py      # 应用工厂 create_app()：密钥、上传限制、钩子、蓝图注册、TLS、清理线程
│   ├── __main__.py      # CLI 入口：python -m minimost --host --port；内置 threaded WSGI + 自签 HTTPS
│   ├── auth.py          # auth_bp：/login /signup /logout /change-password /reset-password/<token>
│   ├── chat.py          # chat_bp：消息、频道、私聊、附件、搜索（约112KB，核心模块）
│   ├── presence.py      # presence_bp：在线状态、输入指示；私有频道成员表也在这里
│   ├── calls.py         # calls_bp：音视频通话生命周期 + WebRTC 信令中转
│   ├── events.py        # events_bp：唯一的 SSE 推送流 GET /events
│   ├── database.py      # auth.db 建表（import 时执行）
│   ├── common.py        # users/messages.db 建表、路径工具
│   ├── paths.py         # 数据根目录解析：$MINIMOST_DATA_DIR 优先，否则源码根目录
│   ├── certs.py/_pki.py # 纯 Python 生成自签 CA/证书（不依赖 openssl）
│   ├── ratelimit.py     # 限流 + 每用户 SSE 并发上限（默认12）
│   ├── clean.py         # 保留期/容量清理
│   ├── preview.py       # 链接预览（会主动抓取外部网页 ⚠️ 与"不联网"冲突，桌面版需禁用）
│   ├── stun.py          # 内置局域网 STUN（UDP 3478），无公网依赖
│   ├── settings.json    # 全部运行配置
│   ├── templates/       # Jinja 服务端渲染（旧前端，保留不删）
│   └── static/          # 旧前端原生 JS（保留不删）
├── tests/               # pytest 后端测试 + jest 前端测试
└── docs/                # 架构/部署/安全文档
```

**与任务背景的一处出入**：实际注册的是 **5 个 Blueprint**（auth / chat / presence / calls / **events**），events 是独立蓝图而非挂在 chat 下。改造计划按 5 个蓝图的实际结构制定。

### 1.2 数据存储（全部 SQLite + 本地目录，WAL 模式）

数据根目录由 `paths.data_dir()` 统一解析（`MINIMOST_DATA_DIR` 环境变量可整体搬迁——桌面化的关键抓手）：

| 存储 | 内容 |
|---|---|
| `auth.db` | `users`（username 主键、password_hash、failed_attempts、lockout_until、password_set_ts）；`user_settings`（name_color、avatar_file、bio）；`password_history`；`password_reset_tokens` |
| `presence.db` | `presence`、`typing`；**`private_channels`**（id 自增、name、created_by、created_ts）；**`private_channel_members`**（channel_id+username 主键、joined_ts、history_start_ts）；`calls`/`call_participants`/`call_signals`/`screenshares`；**`event_signal`**（单行单调计数器，SSE 的唤醒源） |
| `users/messages.db` | `messages`（唯一消息表：channel、sender、content、content_type、filename、ts、编辑/删除/回应时间戳、mentions 等）；`messages_fts`（trigram 全文索引）；`reactions`；`read_state`（每用户每频道已读水位）；`dm_hidden`；`pins` |
| `uploads/` | 消息附件本地文件，经 `GET /files/<filename>` 按频道可见性鉴权后下发 |
| `avatars/` | 头像（旧前端 Canvas 压缩为 128×128 JPEG 后上传；新 UI 沿用同样的客户端压缩策略） |
| `secret.key`、`ca.pem`/`cert.pem`/`key.pem` | 会话签名密钥与自签 TLS 材料 |

**关键事实（影响需求实现方式）**：
- 用户表**没有 display_name 字段**（`user_settings` 只有颜色/头像/bio）。"按显示名搜索"必须先给 `user_settings` 增加 `display_name` 列（纯增量迁移）。
- 任务中所说的 `channel_members` 机制，实际表名是 **`private_channel_members`**，位于 `presence.db`。
- 频道标识三类：公共频道（settings.json 配置名）、私有频道 `private:<id>`、私聊 `dm:alice:bob`（参与者名排序后冒号连接，`normalize_dm` 规范化；群聊私聊即 `dm:a:b:c`）。
- **私有频道的创建/改名/邀请/退出管理路由已存在**（README、`tests/test_routes_private_channels.py`、`chat-channels.js` 证实；⚠️ 具体路由路径待阶段2读 chat.py 逐一核对）。群组管理应在其上扩展，而不是另起炉灶。
- 消息发送 `POST /send/<channel>` 统一处理文本与附件，权限由 `is_valid_channel` 把关（公共频道/私有频道成员/DM 参与者）。**好友私聊与群组消息天然复用这条链路，无需改动。**

### 1.3 SSE 推送机制（events.py，已逐行核实）

- 每个客户端一条 `GET /events?channel=<ch>&after=<ts>` 长连接；约 100ms 一个 tick，只读 `event_signal` 计数器，计数器动了才跑采集器（write-gated，空闲零查询）。
- 计数器由 `__init__.py` 的 `after_request` 钩子 `_signal_state_change` 在 **chat/presence/calls 三个蓝图**的成功写请求后 +1。**新蓝图若不加入这个白名单，写操作不会唤醒 SSE**——这是最容易漏的接线点。
- 采集器分两组：
  - 全局：`online_users`、`dms`、`channel_unreads`、`private_channels`、`mentions`、`unread_count`、`incoming_calls`
  - 频道级：`typing`、`read_receipts`、`pins`、`screenshares`、`active_call`
  - `messages` 单独走游标增量（含 30s 兜底对账）。
- 采集器直接复用 REST 视图函数，推送 payload 与轮询接口字节级一致；JSON 无变化不重发。流约 5 分钟自回收，EventSource 自动重连（Last-Event-ID 续传）。
- 新 UI 用原生 EventSource 对接同一条流，事件语义完全不变。

### 1.4 认证与安全（沿用，不重写）

- Flask 签名 Cookie 会话（`session["user"]`），`@login_required` 装饰器；PBKDF2 哈希；用户名 `[A-Za-z0-9_-]{1,32}`、大小写不敏感唯一、保留名 minimost/everyone/deleteduser。
- 密码策略默认较严（≥15位+大小写+数字+特殊字符，代码只允许调高不允许调低）——桌面版沿用，不做放宽。
- CSRF 仅校验 auth 蓝图的 HTML 表单；chat/presence/calls 的 JSON API 依赖 SameSite=Lax Cookie 豁免。**新增 JSON API 沿用同一模式**。
- ⚠️ 新 UI 的关键适配：现有 `/login`、`/signup` 是 **HTML 表单 POST**（form 字段 + csrf_token + 302 跳转）。新 UI 以 fetch 调用时需：先取 csrf_token（新增一个轻量 GET 端点返回令牌），以 `application/x-www-form-urlencoded` 提交并携带 `X-Requested-With: XMLHttpRequest`，用 `redirect: "manual"` 把 302 解读为成功、200 解读为失败（解析返回的登录页错误信息）。**登录注册逻辑本身零改动**。
- 会话闲置超时（默认15分钟）：`_PASSIVE_ENDPOINTS` 白名单内的后台端点不刷新活跃时间——新增的轮询类端点必须登记进去；未登录时 API 返回 302→/login，新 UI 统一拦截并切回登录页。
- 限流：登录/注册/发送/上传等按 IP/用户限流；每用户 SSE 并发上限 12。

### 1.5 运行方式与 Windows 适配

- 开发：`python -m minimost`（内置 threaded WSGI，默认 https://127.0.0.1:5000，自签证书纯 Python 生成）；`MINIMOST_SKIP_TLS=1` 可走纯 HTTP。
- 生产：Gunicorn gthread（**仅 Linux**）。仓库含 `windows.yml` CI 与 `test_windows_compat.py`，Windows 受支持，但 **Windows 上不能用 Gunicorn**——桌面版用内置 threaded 服务器（小规模足够）或 waitress。
- 旧前端无构建步骤（package.json 仅 eslint/jest/prettier 开发工具）。新 UI 引入独立构建链（见 3.4）。
- ⚠️ 与"不联网"冲突的现有点：`preview.py` 链接预览会抓取外部网页。桌面版默认禁用该功能（其余功能——含内置 STUN——均为局域网/本机，CSP 全部 `'self'`，无 CDN）。

---

## 二、差距分析（需求 vs 现状）

| 需求 | 现状 | 差距 |
|---|---|---|
| 按用户名/显示名搜索用户（分页） | 有 `GET /users`（供 @提及用），无分页搜索；无 display_name 字段 | 新增搜索路由 + display_name 列迁移 |
| 好友申请/审批/列表/删除 | 完全没有 | 新增 friends、friend_requests 表 + 路由 + SSE |
| 好友申请 SSE 实时通知 | SSE 框架现成 | 新增全局采集器 + 新 UI 事件处理 |
| 创建群组/邀请/退出/成员列表 | 私有频道已有创建/邀请/退出/改名基础 | 扩展为"群组"语义：kind 标记 + role 列 + 群名/初始成员参数 |
| 群管理员权限（owner/admin/member） | 私有频道无角色概念 | private_channel_members 增加 role 列 + 权限校验 |
| 好友私聊/群消息走同一存储与推送 | `POST /send/<channel>` + dm:/private: 通道已统一 | **零改动**，仅新 UI 接线 |
| 桌面化（免浏览器/命令行） | 纯 Web，需手动启动 | 新增 Electron 外壳 + 全新 UI + PyInstaller 后端打包 |
| 图标/表情/UI 原创 | Minimost 自有 MIT 素材 | 新 UI 全部自绘，不使用 QQ 商标与素材 |

---

## 三、改造计划

### 3.1 后端文件级改动清单

**修改（均为增量，不破坏现有结构）：**

| 文件 | 改动 |
|---|---|
| `src/minimost/__init__.py` | ① 注册新蓝图 social_bp；② `_signal_state_change` 白名单加入 `"social"`；③ 启动时执行迁移（幂等）；④ 新轮询端点登记 `_PASSIVE_ENDPOINTS`；⑤ 桌面模式开关（禁用链接预览等）；⑥ 新增 csrf-token 轻量 GET 端点（供新 UI 登录表单用） |
| `src/minimost/events.py` | `_GLOBAL_COLLECTORS` 增加 `friend_requests`（待处理申请）、`friends`（好友列表）两个写驱动采集器；群组成员变化复用现有 `private_channels` 采集器 |
| `src/minimost/chat.py` | 在现有私有频道管理路由上扩展群组语义（创建时指定群名+初始成员、邀请、退出、成员列表含角色）；新增角色权限校验（owner/admin/member）；`POST /send/<channel>`、附件、`is_valid_channel` **不动** |
| `src/minimost/database.py` | `user_settings` 增加 `display_name` 列（统一走新迁移模块） |
| `src/minimost/settings.json` | 桌面默认配置：禁用链接预览；上传限制保持 25MB/5MB 不变 |
| `templates/`、`static/` | **保留不删**（旧前端继续可用，浏览器访问不受影响）；不在其上做功能扩展 |

**新增：**

| 文件/目录 | 职责 |
|---|---|
| `src/minimost/social.py` | social_bp：用户搜索（分页）、好友申请发送/查询/同意/拒绝、好友列表/删除。全部 `@login_required` + 参数化 SQL + 复用 ratelimit |
| `src/minimost/migrations.py` + `migrations/001_social.sql` | 独立迁移脚本与运行器：`schema_migrations` 版本表 + 幂等执行；可 `python -m minimost migrate` 单独跑，也在 create_app 启动时自动跑 |
| `desktop/` | **全新桌面 UI 与 Electron 外壳**（见 3.4） |
| `packaging/` | PyInstaller spec、electron-builder 配置、构建脚本 |
| `tests/test_routes_social.py`、`tests/test_routes_groups.py` | 沿用现有 pytest 夹具（conftest 已隔离临时数据目录） |

### 3.2 新增表与列（SQL 细节在阶段2给出）

全部落在**现有数据库文件**内，纯增量：

- `presence.db` 新表：
  - `friends`：规范化双向好友关系（user_a < user_b 排序存储，避免双向重复行），created_ts。
  - `friend_requests`：from_user、to_user、status（pending/accepted/rejected）、created_ts、resolved_ts；对 pending 状态的唯一性约束防重复申请。
- `auth.db` 增列：`user_settings.display_name TEXT`（搜索与展示用；为空时回退用户名）。
- `presence.db` 增列：
  - `private_channels.kind TEXT DEFAULT 'channel'`（`'group'` 标记群组，旧数据默认值不受影响）。
  - `private_channel_members.role TEXT DEFAULT 'member'`；既有私有频道的 created_by 回填为 owner。
- 各库 `schema_migrations(version, applied_ts)` 记录迁移版本。

**群组 = 带 kind='group' 的私有频道**：频道标识仍是 `private:<id>`，权限仍由 `private_channel_members` + `is_valid_channel` 把关，消息仍进 `messages.db` 同一张 messages 表、同一条 SSE 通道。不新建平行消息体系。

**角色权限矩阵（owner/admin/member 三级）：**

| 操作 | owner | admin | member |
|---|---|---|---|
| 发消息/图片、查看历史 | ✓ | ✓ | ✓ |
| 邀请新成员 | ✓ | ✓ | ✓（可配置收紧） |
| 移除成员 | ✓ | ✓（不能移除 owner/admin） | ✗ |
| 改群名 | ✓ | ✓ | ✗ |
| 任命/撤销 admin | ✓ | ✗ | ✗ |
| 转让 owner、解散群组 | ✓ | ✗ | ✗ |
| 退出群组 | ✓（需先转让或触发自动继任） | ✓ | ✓ |

### 3.3 SSE 事件扩展

| 新事件 | 组 | 触发 | payload |
|---|---|---|---|
| `friend_requests` | 全局 | 写驱动 | 当前用户收到的待处理申请列表（与 REST 查询一致） |
| `friends` | 全局 | 写驱动 | 好友列表（在线状态由前端与 online_users 合并） |
| 群组变化 | 复用 `private_channels` | 写驱动 | 群组创建/邀请/退出后，成员列表采集器自动重推 |

接线三要点（漏一即失效）：
1. social_bp 写请求 → `_signal_state_change` 白名单放行 → `event_signal` +1；
2. events.py 注册采集器（复用 social 视图函数，保证推送=REST）；
3. 新 UI 的 EventSource 处理器增加事件分发 → 角标/提示/列表刷新。

### 3.4 桌面化方案：全新 UI + Electron（Windows 优先）

**技术选型（默认，可在阶段2前调整）**：Electron + React + TypeScript + Vite。
- 状态管理用轻量方案（Zustand），不引重型框架；样式自写 CSS，不依赖第三方组件库（保证 UI 原创与离线）。
- 选 React 的理由：好友/群组/消息多面板状态同步复杂，组件化收益明显；构建产物为纯静态文件，运行期零外部依赖。
- 旧前端不删除：Flask 仍伺服 `/`（Jinja 页面），浏览器用户不受影响；桌面窗口加载新 UI。

```
MiniMost Desktop.exe (Electron)
  ├─ 主进程：单实例锁 → 启动后端子进程 → 健康检查 → 打开窗口
  ├─ 子进程：minimost-server.exe（PyInstaller 打包，内置 threaded WSGI）
  │    环境变量：MINIMOST_DATA_DIR=%APPDATA%/MiniMostDesktop
  │             MINIMOST_SKIP_TLS=1（仅绑定 127.0.0.1，走 HTTP 回环）
  ├─ 渲染窗口：加载打包内的新 UI 静态页（file:// 或自定义协议）
  │    所有 API/SSE/附件请求指向 http://127.0.0.1:<port>（同源代理或 CORS 白名单）
  │    启动即登录/注册页（复用后端 /login /signup，fetch + CSRF 适配见 1.4）
  └─ 退出：窗口关闭 → 结束后端子进程树；数据全部留在 %APPDATA% 数据目录
```

要点：
- **免浏览器/命令行**：双击图标 → 后端自动起 → 窗口直达登录页；端口默认 5000，占用时自动选空闲端口。
- **回环 HTTP 的可行性**：Chromium 把 `http://127.0.0.1` 视为安全上下文，摄像头/麦克风/WebRTC 仍可用，省去自签证书信任处理；局域网服务端模式仍保留 HTTPS。
- **跨源细节**：新 UI 以 file:// 加载时，对 127.0.0.1 的请求属跨源——由 Electron 主进程做本地代理（或后端为桌面模式放开受限 CORS + Cookie SameSite 适配），阶段2定案；SSE 走同一通道。
- **数据全本地**：SQLite + uploads/ + avatars/ 全部在 `%APPDATA%/MiniMostDesktop`（通过现成的 `MINIMOST_DATA_DIR` 机制，后端零侵入）；卸载不删数据。
- **不联网**：禁用链接预览；无公网 STUN/TURN；新 UI 资源全部打包本地、无 CDN；Electron 禁用远程内容。
- **打包**：electron-builder → NSIS 安装包（.exe），后端 dist 作为 extraResources 随包分发；图标为原创 .ico。
- **构建链**（阶段5给完整命令）：`pyinstaller packaging/minimost-server.spec` → `cd desktop && npm install && npm run build` → `npm run dist`。
- **备选 Tauri**：安装包更小，但需 Rust 工具链、Python 以 sidecar 管理，Windows 依赖 WebView2，SSE/WebRTC 行为随系统 WebView 版本波动。默认按 Electron 推进。
- **macOS**：本期不做。架构上 Electron + PyInstaller 均可跨平台，后续只需增加 mac 打包目标与数据目录适配，后端无需改动。

**新 UI 功能范围（分两批）：**
- 第一批（阶段3/4 同步交付）：登录/注册、频道与私聊列表、消息收发（文本+图片附件、SSE 实时）、用户搜索、好友申请/审批/列表/删除、群组创建/邀请/退出/成员管理、设置（显示名、头像、服务端地址切换）。
- 第二批（后续迭代，不阻塞本次验收）：消息编辑/删除/回应、@提及、置顶、消息搜索、已读回执、音视频通话界面。后端能力均已存在，仅差 UI 接线。

### 3.5 局域网多机模式（阶段5细化）

- **一台机器当服务端**：运行同一程序的"服务端模式"（等价 `minimost --host 0.0.0.0`，HTTPS + 自签 CA），SQLite 与文件都在这台机器上——"数据本地"指数据留在局域网内自己的机器，不上云。
- **其他机器**：桌面客户端设置里填服务端地址（客户端模式不启动本地后端，窗口直接连 `https://<服务端IP>:5000`），首次导入服务端提供的 `ca.pem`（现成 `GET /ca.pem` 下载路由）消除证书告警；或直接用浏览器访问旧前端。
- 防火墙：服务端放行 TCP 5000（聊天/上传/信令）；如需音视频再放行 UDP 3478 与客户端间临时 UDP。
- 单机模式与服务端模式互斥切换，避免两份数据库。

### 3.6 原创素材

- 新 UI 全部自绘：应用 Logo（SVG → ICO/PNG 全尺寸）、窗口/托盘图标、好友/群组等功能图标、自绘表情/贴纸集。
- 不使用 QQ 任何商标、图标、表情素材；Minimost 原素材虽为 MIT，新 UI 也不复用其品牌元素。

### 3.7 风险与假设

| 项 | 说明 | 处置 |
|---|---|---|
| 全新 UI 工作量 | 比重写后端大得多，是本项目最大成本项 | 分两批交付（3.4）；第一批覆盖全部必做功能；阶段2先出 UI 结构稿 |
| 登录表单与新 UI 的适配 | 现有登录是 HTML 表单+CSRF+302 | fetch 适配方案见 1.4；后端逻辑零改动 |
| file:// 跨源请求 | Cookie/SSE 需代理或 CORS 适配 | 阶段2定案（默认 Electron 本地代理） |
| chat.py 体量大（112KB） | 私有频道管理路由具体路径尚未逐行核对 | 阶段2先核对再动刀；群组逻辑薄封装 |
| Windows 无 Gunicorn | 内置 threaded 服务器并发能力有限 | 桌面/小规模局域网足够；服务端模式可选 waitress |
| 新蓝图 SSE 不唤醒 | 白名单/采集器/前端分发三处接线 | 列入阶段5测试要点首项 |
| 闲置超时误伤新端点 | 轮询端点未登记会刷新活跃时间或 302 | 新 GET 轮询端点登记 `_PASSIVE_ENDPOINTS` |
| "显示名"不存在 | 需新增列并考虑旧账号回退 | display_name 为空回退 username |
| 密码策略严格（≥15位） | 代码禁止调低 | 沿用不重写（符合"账号系统不重写"约束） |
| 链接预览外联 | 与"不联网"冲突 | 桌面默认禁用，配置可开关 |

**默认假设**（如不同意请指出）：
1. 目标平台 Windows 10/11 x64，macOS 本期不做；
2. 打包用 Electron，新 UI 用 React + TypeScript + Vite；
3. "数据全部本地"在局域网模式下解释为"数据留在服务端那台机器，不出局域网、不上云"；
4. 好友私聊复用现有 `dm:a:b` 通道（成为好友只是解锁"发起私聊"入口，不改变消息存储）。

---

## 四、后续阶段预告

- **阶段2**：新增表/列的完整 SQL + 迁移脚本设计；用户搜索、好友、群组全部路由的方法/路径/参数/返回/权限设计；新 UI 页面结构与登录适配定案。
- **阶段3**：实现用户搜索 + 好友系统（含 SSE 通知）+ 新 UI 第一批对应页面 + 测试。
- **阶段4**：实现群组创建/邀请/退出/成员管理（三级角色），与现有消息路由对接 + 测试。
- **阶段5**：Electron/PyInstaller 打包配置、开发运行与 .exe 构建完整步骤、迁移执行方式、局域网部署说明、测试要点清单。

---

## 五、关键问题确认记录

| # | 问题 | 结论 |
|---|---|---|
| 1 | 是否保留 Minimost Web 前端 | **不保留为主界面：重写全新桌面 UI**；旧前端保留在仓库中继续可用 |
| 2 | 好友申请是否需要 SSE 实时通知 | **需要**（需求已明确，直接实现） |
| 3 | 群组是否需要管理员角色 | **需要：owner/admin/member 三级**（权限矩阵见 3.2） |
| 4 | 图片上传大小限制是否调整 | **保持现状**：单文件 25MB、头像 5MB |
| 5 | 是否接受现有 Blueprint 上扩展而非新建服务 | **接受**：同进程新增 social 蓝图 + 扩展 chat 蓝图 |