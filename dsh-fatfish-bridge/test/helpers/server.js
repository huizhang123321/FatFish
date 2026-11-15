/**
 * 测试辅助：启动一个隔离的 FatFish 服务端。
 *
 * 用 `MINIMOST_DATA_DIR` 指向临时目录，绝不碰用户 `%APPDATA%\FatFish` 里的真实数据；
 * 用 `MINIMOST_SKIP_TLS=1` 走明文 HTTP（桌面端也是这么跑的）。
 */

import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { CookieJar } from '../../src/fatfish-client.js'

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
export const TEST_PASSWORD = 'FatFishBridge2026!'

/** 找一个空闲端口。 */
export async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(address.port))
    })
  })
}

function pythonExecutable() {
  const candidates = [
    path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe'),
    path.join(REPO_ROOT, '.venv', 'bin', 'python'),
    'python',
  ]
  return candidates[0]
}

async function waitForHealth(baseUrl, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let lastError = '无响应'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/app/health`, {
        signal: AbortSignal.timeout(1000),
      })
      if (response.ok) {
        const data = await response.json()
        if (data?.status === 'ok') return data
      }
    } catch (error) {
      lastError = error.message
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`FatFish 服务未在 ${timeoutMs}ms 内就绪：${lastError}`)
}

/**
 * 启动服务端。
 *
 * @returns {Promise<{ baseUrl: string, dataDir: string, stop: () => Promise<void> }>}
 */
export async function startFatFishServer() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatfish-bridge-test-'))
  const port = await findFreePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const env = {
    ...process.env,
    PYTHONPATH: path.join(REPO_ROOT, 'minimost', 'src'),
    MINIMOST_DATA_DIR: dataDir,
    MINIMOST_SKIP_TLS: '1',
    MINIMOST_DESKTOP: '1',
    PYTHONUNBUFFERED: '1',
  }
  // 沙箱环境禁止管道式 stdio，所以把服务端输出重定向到文件，而不是 pipe。
  const logPath = path.join(dataDir, 'server.log')
  const logFd = openSync(logPath, 'a')
  const child = spawn(
    pythonExecutable(),
    ['-m', 'minimost', '--host', '127.0.0.1', '--port', String(port)],
    { cwd: REPO_ROOT, env, stdio: ['ignore', logFd, logFd], windowsHide: true },
  )

  try {
    await waitForHealth(baseUrl)
  } catch (error) {
    child.kill()
    const output = await fs.readFile(logPath, 'utf8').catch(() => '')
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    throw new Error(`${error.message}\n--- server output ---\n${output.slice(-8000)}`)
  } finally {
    closeSync(logFd)
  }

  return {
    baseUrl,
    dataDir,
    async stop() {
      child.kill()
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

/**
 * 通过 HTTP 注册账号（注册成功后该会话即为登录态）。
 *
 * @param {string} baseUrl
 * @param {string} username
 * @param {string} [password]
 * @returns {Promise<{ cookie: string }>} 登录后的 Cookie 头。
 */
export async function signup(baseUrl, username, password = TEST_PASSWORD) {
  const jar = new CookieJar()
  const csrfResponse = await fetch(`${baseUrl}/csrf-token`)
  jar.absorb(csrfResponse)
  const csrf = await csrfResponse.json()
  const body = new URLSearchParams({
    username,
    password,
    confirm_password: password,
    csrf_token: csrf.csrf_token,
  })
  const response = await fetch(`${baseUrl}/signup`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: jar.header(),
    },
    body,
    redirect: 'manual',
  })
  jar.absorb(response)
  if (response.status !== 302 && response.status !== 303) {
    const html = await response.text()
    const message = /<div class="auth-error">([\s\S]*?)<\/div>/i.exec(html)?.[1] ?? ''
    throw new Error(`注册 ${username} 失败（HTTP ${response.status}）：${message.trim()}`)
  }
  return { cookie: jar.header() }
}

/**
 * 用已登录 Cookie 发一条消息（测试里让“另一个人”发言）。
 */
export async function sendWithCookie(baseUrl, cookie, channel, text) {
  const response = await fetch(`${baseUrl}/send/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
    },
    body: new URLSearchParams({ text }),
  })
  const body = (await response.text()).trim()
  if (!response.ok || (body && body !== 'ok')) {
    throw new Error(`发送消息失败（HTTP ${response.status}）：${body}`)
  }
  return body
}

/** 带 Cookie 读取频道消息。 */
export async function readWithCookie(baseUrl, cookie, channel, after = 0) {
  const response = await fetch(
    `${baseUrl}/messages/${encodeURIComponent(channel)}?after=${after}`,
    { headers: { cookie } },
  )
  if (!response.ok) throw new Error(`读取消息失败（HTTP ${response.status}）`)
  return response.json()
}
