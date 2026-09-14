// 测试辅助：把 host 半区挂到一个假的 Cordis ctx 上，并提供 HTTP 级别的调用工具。
//
// 设计目标：不依赖真实 dsh 进程、不依赖网络、不需要 Windows —— 除了标了
// `requiresWindows` 的用例。这样测试能在任何 CI 上跑。

import { strict as assert } from 'node:assert'

/** 插件 host 半区入口（相对本文件）。 */
export const HOST_ENTRY = new URL('../index.js', import.meta.url).href

/** 加载插件模块。 */
export function loadPlugin() {
  return import(HOST_ENTRY)
}

/**
 * 创建一个假的插件上下文，捕获 apply() 注册的路由。
 * @returns {{ ctx: object, box: { handler: Function|null, registered: boolean, logs: string[] } }}
 */
export function makeCtx() {
  const box = { handler: null, registered: false, route: null, logs: [] }
  const ctx = {
    logger: {
      info: (s) => box.logs.push(String(s)),
      warn: (s) => box.logs.push('WARN ' + String(s)),
    },
    webServer: {
      register(route) {
        box.handler = route.handler
        box.route = route
        box.registered = true
        return () => { box.registered = false }
      },
    },
    effect(fn) { fn() },
  }
  return { ctx, box }
}

/**
 * 直接驱动 handler，模拟一次 HTTP 请求。
 * 返回 { code, body, json }。
 */
export function call(box, { method = 'GET', url, headers = {}, body = null }) {
  assert.ok(box.handler, 'handler 未注册 —— 请先 apply()')

  const listeners = {}
  const req = {
    method,
    url,
    headers,
    on(evt, cb) { listeners[evt] = cb; return this },
    destroy() { listeners.__destroyed = true },
  }

  const res = { code: null, body: null }
  res.writeHead = function (c) { this.code = c }
  res.end = function (b) { this.body = b }

  // 关键：必须先派发 body 事件，再 await handler。
  // readBody() 会一直等到 'end' 才 resolve；若先 await handler，
  //   handler 等 body → body 等 handler 返回  →  死锁（POST 用例会挂起）。
  // 用 setImmediate 让 handler 先跑起来、注册好监听器，再投递事件。
  const bodyDelivered = new Promise((resolve) => {
    setImmediate(() => {
      if (body !== null && listeners.data) listeners.data(Buffer.from(body))
      if (listeners.end) listeners.end()
      // 让 readBody 的 resolve 走完
      setImmediate(resolve)
    })
  })

  const done = Promise.resolve(box.handler(req, res)).catch((e) => {
    // handler 内部已 try/catch，走到这里说明是围栏之前的意外错误
    res.code = res.code ?? 599
    res.body = JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) })
  })

  return Promise.all([done, bodyDelivered]).then(() => ({
    code: res.code,
    body: res.body,
    json: (() => { try { return JSON.parse(res.body) } catch { return null } })(),
    destroyed: !!listeners.__destroyed,
  }))
}

/** 一个「同源浏览器请求」的请求头，正常路径应当通过围栏。 */
export const SAME_ORIGIN = Object.freeze({
  host: '127.0.0.1:3080',
  origin: 'http://127.0.0.1:3080',
  'content-type': 'application/json',
})

/** 极简断言计数器。 */
export function createReporter() {
  let passed = 0
  let failed = 0
  const failures = []

  return {
    check(name, cond, detail = '') {
      if (cond) {
        passed++
        console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`)
      } else {
        failed++
        failures.push(name)
        console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`)
      }
    },
    async group(title, fn) {
      console.log(`\n${title}`)
      await fn()
    },
    summary() {
      console.log(`\n${'─'.repeat(60)}`)
      console.log(`通过 ${passed} / 失败 ${failed}`)
      if (failed > 0) {
        console.log('失败用例：')
        for (const f of failures) console.log(`  - ${f}`)
      }
      return failed
    },
  }
}

/** 当前是否 Windows。 */
export const IS_WINDOWS = process.platform === 'win32'
