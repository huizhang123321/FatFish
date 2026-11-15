# 把 dsh-fatfish-bridge 安装给别人

这份说明是给**接收方**看的，也可以直接连同插件一起发过去。

## 接收方需要什么

- **DSH**（DeepSeek Harness）≥ 0.2，Node.js ≥ 20
- **FatFish**：桌面端开着，或者能访问一个 FatFish 服务端
- 一个**单独的 FatFish 机器人账号**（例如 `dshbot`），不要用自己的主账号
- 如果机器人要进群/私有频道，先把它拉进去

插件本身不需要编译，装好就能用；它通过 FatFish 的 HTTP 接口登录、读消息、发回复。

## 方式 A：压缩包 + 本地 link（最推荐）

1. 把 `dsh-fatfish-bridge-0.1.0.zip` 解压到任意目录，例如：

```text
D:\dsh-fatfish-bridge
```

2. 在命令行里安装到自己的 DSH profile：

```powershell
# profile 名字按自己的来；不确定就去掉 --profile 用默认 profile
dsh plugin --profile desktop add "link:D:\dsh-fatfish-bridge"
```

macOS / Linux：

```bash
dsh plugin --profile desktop add "link:/Users/you/dsh-fatfish-bridge"
```

3. 重启 DSH（或把插件关开一次）。

> `dsh` 不在 PATH 里时，可以用 DSH 桌面端的插件管理界面安装：选择“从本地目录安装”，
> 指向解压后的 `dsh-fatfish-bridge` 目录即可。

## 方式 B：npm 包

发布者把包发到 npm 之后，接收方只需要：

```powershell
dsh plugin --profile desktop add dsh-fatfish-bridge
```

升级：

```powershell
dsh plugin --profile desktop add dsh-fatfish-bridge@latest
```

## 方式 C：Git 仓库 / 源码

```powershell
git clone https://github.com/<你的账号>/dsh-fatfish-bridge.git
dsh plugin --profile desktop add "link:.\dsh-fatfish-bridge"
```

这种方式适合需要改代码的人；改完源码重启 DSH 即可，源码就是运行代码（没有构建步骤）。

## 配置机器人账号（每个接收方都要做）

在**自己的** `~/.dsh/.credentials.yaml` 里加：

```yaml
refs:
  FATFISH_USERNAME: "dshbot"
  FATFISH_PASSWORD: "机器人账号密码"
```

- 不要把自己的密码或 `.credentials.yaml` 发给别人；每人用自己的机器人账号。
- 机器人账号的密码要满足 FatFish 的注册规则（至少 15 位，含大小写、数字、特殊字符）。
- 如果 FatFish 服务端不在本机，或者端口不是自动发现的那个，再加：

```yaml
refs:
  FATFISH_URL: "http://192.168.1.20:5000"
```

然后在自己的 profile 里按需配置频道和授权用户，例如
`~/.dsh/profiles/desktop/cordis.patch.yml`：

```yaml
- id: dsh-fatfish-bridge
  config:
    channels: "general, private:3"
    allowed_senders: "你的FatFish用户名"
    mention_required: true
```

改完配置重启 DSH。

## 怎么确认装好了

1. DSH 的插件列表里能看到 `dsh-fatfish-bridge`，状态是 `active`。
2. 在 FatFish 里私聊机器人，发：

```text
/帮助
```

收到命令清单就说明登录、轮询、回复整条链路都通了。

如果只回了“账号或密码缺失”的日志、FatFish 里没反应，通常是：

- `.credentials.yaml` 的 `refs` 没写对，或 DSH 没重启；
- 机器人账号密码错误 / 被登录限流；
- 公共频道里没配 `allowed_senders`，或者没有 @机器人；
- 私聊没开 `watch_dms: true`，也没把 `dm:...` 写进 `channels`。

## 升级与卸载

- **link 安装**：替换解压后的文件夹，重启 DSH 即可。
- **npm 安装**：`dsh plugin --profile <profile> add dsh-fatfish-bridge@latest`。
- **卸载**：在 DSH 插件管理里移除/禁用 `dsh-fatfish-bridge`，或从 profile 的
  `package.json` 的 `dsh.profile.bundles` 中删掉它。

## 给分发者：怎么打包

在插件目录里执行：

```powershell
# 生成 npm 包（默认输出到当前目录）
npm pack

# 生成 zip（排除缓存/依赖）
Compress-Archive -Path .\dsh-fatfish-bridge -DestinationPath .\dsh-fatfish-bridge-0.1.0.zip
```

把 `dsh-fatfish-bridge-0.1.0.tgz` 或 `.zip` 发给对方即可。两种包内容一样：
`src/`、`cordis.patch.yml`、`README.md`、`INSTALL.md`、`package.json`、`LICENSE`、`NOTICE`。

发布到 npm：

```powershell
npm publish --access public
```

发布前确认包名 `dsh-fatfish-bridge` 在 npm 上还没被占用。

## 安全提醒

- 这个插件能让授权用户在**本机 DSH** 里执行操作；只把 `allowed_senders` 加给信任的人。
- `allowed_senders` 留空时只服务私聊，这是有意的安全默认值，不要为了方便在公共频道里随便放开。
- 一个机器人账号只给一个 DSH 实例用；多个实例抢同一会话会触发 DSH 的排他锁。
