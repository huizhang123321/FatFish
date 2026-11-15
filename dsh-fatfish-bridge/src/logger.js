/**
 * dsh-fatfish-bridge: 日志工具
 *
 * 优先使用 DSH 注入的 `ctx.logger(name)`，不可用时回退到 console。
 * 只做一次显式能力判断，不做 `ctx.get('logger') || ctx.logger` 式的双兜底。
 */

/** 创建 console 兜底 logger。 */
export function createLogger(name) {
  const prefix = `[${name}]`
  return {
    info: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
    debug: (...args) => {
      if (process.env.DEBUG) console.debug(prefix, ...args)
    },
  }
}

/** 从 Cordis 上下文解析 logger，缺失或形状不对时回退 console。 */
export function resolveLogger(ctx, name) {
  const factory = ctx?.logger
  if (typeof factory === 'function') {
    try {
      const logger = factory(name)
      if (logger && typeof logger.info === 'function') return logger
    } catch {
      // 回退 console
    }
  }
  return createLogger(name)
}
