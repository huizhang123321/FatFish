# FatFish

一个纯本地运行的聊天软件：Windows 桌面客户端 + 本地 Flask 服务端，数据全部存在本机
（SQLite + 本地文件），不依赖任何云服务，同一个局域网内可以多台机器共享一台服务端。

- **桌面客户端**：Electron + React + TypeScript（`desktop/`）
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
| 对外接口 | 「API 接入服务」：生成令牌后外部程序可推送消息（`POST /api/v1/messages`） |

## 目录

```
minimost/           Flask 后端（src/minimost），含数据库迁移、模板、静态资源
desktop/            Electron 外壳 + React 前端（src/），Vite 构建
packaging/          PyInstaller spec、NSIS 安装脚本、图标生成、构建脚本
*.md               各阶段设计与交接文档
verify_*.py        各功能与安装包/升级路径的端到端验证脚本
run_tests_local.py 本地测试运行器
```

## 开发运行

```powershell
# 后端
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

安装包是**覆盖式升级**：直接运行新版即可，程序目录原地更新，`%APPDATA%\FatFish`
下的账号与聊天记录不受影响。

## 测试

```powershell
python run_tests_local.py                 # 全部后端回归
python verify_installer.py                # 安装包内容校验
python verify_upgrade.py                  # 升级覆盖 + 数据保留
python verify_group_join.py               # 群号加群端到端
python verify_voice_stickers.py           # 语音与文件/贴纸端到端
```

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

## 许可

本项目以 **MIT** 协议开源，见 [LICENSE](LICENSE)。

它在 [MiniMost](https://github.com/SamuelDonovan/minimost)（作者 Samuel Mehalko，同样 MIT）
的基础上二次开发：FatFish 增加了 Electron 桌面外壳、React/TypeScript 界面、群组与群号、
语音与文件附件、表情贴纸、API 接入服务、日夜主题，以及 PyInstaller + NSIS 的打包链路。
上游的授权原文保留在 [`minimost/LICENSE`](minimost/LICENSE)，并已在本项目 LICENSE 中一并附上。

界面与贴纸素材（`minimost/src/minimost/static/stickers/`、`packaging/` 下的图标等）
均为本项目原创绘制，不包含任何第三方聊天软件的素材或商标。

## 参与

欢迎提 issue 和 PR。改动后请至少跑一遍：

```bash
python run_tests_local.py
cd desktop && npx tsc --noEmit
```

