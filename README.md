# FatFish

一个纯本地运行的聊天软件：Windows 桌面客户端 + Android 客户端 + 本地 Flask 服务端，
数据全部存在本机（SQLite + 本地文件），不依赖任何云服务，同一个局域网内可以多台
机器共享一台服务端。

- **桌面客户端**：Electron + React + TypeScript（`desktop/`）
- **Android 客户端**：原生外壳 + 同源 WebView，手机版 React 界面（`安卓端/`）
- **服务端**：Python + Flask + SQLite + SSE（`minimost/`）
- **打包**：PyInstaller 打包后端，NSIS 生成安装包（`packaging/`）

## 功能

| 分类 | 内容 |
|---|---|
| 聊天 | 公共频道、私有频道、群组、私聊；图片/语音/任意文件；@提及、表情反应、消息编辑与撤回 |
| 群组 | 群号（8 位，可分享）、用群号或群名查找、入群申请与审批、管理员/群主权限、转让与解散 |
| 富文本输入 | Unicode 表情面板（插入光标处）、原创贴纸、自己导入的表情包（存服务端，所有人共用） |
| 外观 | 日间 / 夜间主题，偏好存在账号上而不是浏览器里 |
| 账号 | 注册、登录、修改密码、重置链接；「记住密码」自动登录 |
| 其他 | 好友与请求、在线状态、输入提示、未读计数、消息搜索、头像 |
| Android | 原生连接页、手机版聊天界面、自签名证书确认、文件/语音/下载、系统返回与主题 |
| 对外接口 | 「API 接入服务」：生成令牌后外部程序可推送消息（`POST /api/v1/messages`） |

## 目录

```
minimost/           Flask 后端（src/minimost），含数据库迁移、模板、静态资源
desktop/            Electron 外壳 + React 前端（src/），Vite 构建
安卓端/              Android 客户端（原生 Java + WebView + 构建脚本 + APK）
packaging/          PyInstaller spec、NSIS 安装脚本、图标生成、构建脚本
*.md               各阶段设计与交接文档
verify_*.py        各功能与安装包/升级路径的端到端验证脚本
run_tests_local.py 本地测试运行器
```

## 开发运行

```powershell
# 后端
$env:PYTHONPATH = "$PWD\minimost\src"
.\.venv\Scripts\python.exe -m minimost --host 127.0.0.1 --port 5000

# 前端（另开一个终端，热更新，代理到 5000）
cd desktop; npm install; npm run dev
```

## 构建与打包

```powershell
# 前端 → Python 包内的 desktop_ui
cd desktop; npm run build

# 后端 → packaging/dist/minimost-server
python -m PyInstaller packaging\minimost-server.spec --distpath packaging\dist --noconfirm

# 安装包 → desktop/release/FatFish-Setup-<版本>-x64.exe
powershell -ExecutionPolicy Bypass -File packaging\make-installer.ps1
```

Android 客户端（需要 JDK 17 + Android SDK 35，详见 [安卓端说明](安卓端/README.md)）：

```powershell
cd 安卓端
powershell -ExecutionPolicy Bypass -File .\build.ps1
# → 安卓端/dist/FatFish-Android-<版本>.apk
```

安装包是**覆盖式升级**：直接运行新版即可，程序目录原地更新，`%APPDATA%\FatFish`
下的账号与聊天记录不受影响。

## 测试

```powershell
python run_tests_local.py                 # 全部后端回归
python verify_installer.py                # 安装包内容校验
python verify_upgrade.py                  # 升级覆盖 + 数据保留
python verify_group_join.py               # 群号加群端到端
python verify_voice_stickers.py           # 语音与文件/贴纸端到端
cd desktop && npx tsc --noEmit            # 前端类型检查
```

## Android 客户端

Android 端是**客户端**，不内置 Python 服务端：先在电脑上以局域网模式启动 FatFish，
再用手机连接。连接页会探测 `/app/health`，HTTPS 自签证书会单独让用户确认，不会静默信任。
聊天界面与桌面端共用同一套 React 代码和同源 Cookie，只增加了手机断点布局、底部导航、
返回键、文件选择、麦克风/相机权限和下载；启动图标与桌面端同款。Android 1.2.0 起改为
**只做连接**：不内置 Tailscale、不申请系统 VPN。跨网络访问时，手机先安装官方 Tailscale
App 接入 tailnet，再把电脑的 tailnet 地址填进 FatFish。完整安装与构建步骤见
[安卓端/README.md](安卓端/README.md)。

## 数据位置

运行时的数据在 `%APPDATA%\FatFish\data`：

```
auth.db          账号
presence.db      好友、群组、令牌、贴纸
users/messages.db 频道与消息
uploads/ avatars/ stickers/   上传文件、头像、导入的贴纸
secret.key       会话密钥
```

这些**都不在版本库里**（见 `.gitignore`），卸载程序也刻意保留它们。

## 远程访问（可选）

内置官方 [tsnet](https://tailscale.com/kb/1244/tsnet) 节点：开启后会把本机加入你的 tailnet，
手机、笔记本可以直接访问，而不需要端口映射、也不需要把服务暴露到局域网或公网。

- 电脑端：服务端始终只监听 `127.0.0.1`，外部唯一入口是 tailnet（WireGuard 加密 + ACL 授权）。
  在「设置 → 远程访问（Tailscale）」里填节点名后启动；没有授权密钥时按提示用浏览器登录一次。
  侧车源码在 [`tsnet-sidecar/`](tsnet-sidecar/)，用 Go 构建，随安装包分发。
- Android 1.2.0+：**只做连接**。手机先安装官方 Tailscale App 并接入同一个 tailnet，
  然后在 FatFish 连接页直接填电脑的 tailnet 地址（例如 `fatfish:80` 或
  `http://100.x.x.x:80`）。FatFish 不内置 tsnet、不申请系统 VPN；详见
  [安卓端说明](安卓端/README.md)。
## 许可

本项目以 **MIT** 协议开源，见 [LICENSE](LICENSE)。

它在 [MiniMost](https://github.com/SamuelDonovan/minimost)（作者 Samuel Mehalko，同样 MIT）
的基础上二次开发：FatFish 增加了 Electron 桌面外壳、React/TypeScript 界面、Android 客户端、
群组与群号、语音与文件附件、表情贴纸、API 接入服务、日夜主题，以及 PyInstaller + NSIS 的打包链路。

上游的版权声明、运行时依赖的授权情况见 [NOTICE](NOTICE)；上游原文也保留在
[`minimost/LICENSE`](minimost/LICENSE)。

界面与贴纸素材（`minimost/src/minimost/static/stickers/`、`packaging/` 下的图标等）
均为本项目原创绘制，不包含任何第三方聊天软件的素材或商标。

## 参与

欢迎提 issue 和 PR。改动后请至少跑一遍：

```bash
python run_tests_local.py
cd desktop && npx tsc --noEmit
```

