// 契约与平台测试：模块导出、平台守卫、配置解析。
//
// 平台守卫是本插件「发布级」的关键：非 Windows 上必须**不注册路由且不抛错**，
// 否则装了插件的 macOS/Linux 用户会看到 dsh 启动异常。

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPlugin, makeCtx, IS_WINDOWS } from './helpers.mjs'

const plugin = await loadPlugin()

// ── 模块契约 ────────────────────────────────────────────────────────────────

test('契约：导出 name / inject / apply / Config', () => {
  assert.equal(plugin.name, 'desktop-launcher')
  assert.ok(Array.isArray(plugin.inject))
  assert.ok(plugin.inject.includes('webServer'), 'inject 必须包含 webServer')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.Config, 'object')
  assert.equal(plugin.Config.port, 3080)
  assert.ok(plugin.Config['~standard'] && typeof plugin.Config['~standard'].validate === 'function')
  const result = plugin.Config['~standard'].validate({ port: 3099 })
  assert.equal(result.issues, undefined)
  assert.equal(result.value.port, 3099)
})

test('契约：package.json 声明 dsh.client 与 client 导出', () => {
  const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

  assert.equal(pkg.name, 'dsh-desktop-launcher')
  assert.equal(pkg.type, 'module')
  assert.ok(pkg.dsh?.client, '缺少 dsh.client 声明')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh.client.inject))
  assert.equal(pkg.exports['./client'], './client.js', '缺少 ./client 导出')
})

test('契约：package.json 可发布（无 private，声明 os）', () => {
  const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

  assert.equal(pkg.private, undefined, 'private: true 会阻止 npm publish')
  assert.deepEqual(pkg.os, ['win32'], '必须声明仅支持 Windows')
  assert.ok(pkg.license, '缺少 license 字段')
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, '缺少 files 白名单')
})

test('契约：启动脚本用 HTTP 判定而不是单纯端口扫描', () => {
  const srcPath = fileURLToPath(new URL('../index.js', import.meta.url))
  const src = readFileSync(srcPath, 'utf8')

  assert.match(src, /Invoke-WebRequest|Test-DshUp/, '启动脚本应检查 HTTP 可达性而不是仅看端口监听')
  assert.match(src, /Get-Command\s+dsh|dsh\.cmd|where\.exe/, '启动脚本应解析真实的 dsh 命令路径')
})

test('客户端：uninstall 必须走 POST，status 必须走 GET', () => {
  const clientPath = fileURLToPath(new URL('../client.js', import.meta.url))
  const src = readFileSync(clientPath, 'utf8')

  assert.match(src, /action === "status"|body === undefined && action !== "install" && action !== "uninstall"/, 'status 请求应保留 GET 语义')
  assert.match(src, /action === "uninstall"/, '卸载请求应显式走 POST')
})

test('契约：交付文件齐全', () => {
  for (const f of ['index.js', 'client.js', 'package.json', 'README.md', 'LICENSE']) {
    const p = fileURLToPath(new URL(`../${f}`, import.meta.url))
    assert.doesNotThrow(() => readFileSync(p), `缺少 ${f}`)
  }
})

// ── 平台守卫 ────────────────────────────────────────────────────────────────

test('平台守卫：非 Windows 上不注册路由且不抛错', async (t) => {
  if (IS_WINDOWS) {
    // 在 Windows 上通过改写常量模拟其他平台
    const srcPath = fileURLToPath(new URL('../index.js', import.meta.url))
    const dir = mkdtempSync(join(tmpdir(), 'dsh-dl-'))
    try {
      let src = readFileSync(srcPath, 'utf8')
      const patched = src.replace(
        "const IS_WINDOWS = process.platform === 'win32'",
        'const IS_WINDOWS = false'
      )
      assert.notEqual(patched, src, '未能定位 IS_WINDOWS 常量（源码结构变了？）')

      const tmpFile = join(dir, 'index.mjs')
      writeFileSync(tmpFile, patched, 'utf8')
      const mod = await import(`file://${tmpFile.replace(/\\/g, '/')}`)

      const { ctx, box } = makeCtx()
      let threw = null
      try { mod.apply(ctx, {}) } catch (e) { threw = e }

      assert.equal(threw, null, `非 Windows 上抛错了: ${threw?.message}`)
      assert.equal(box.registered, false, '非 Windows 上不应注册路由')
      assert.ok(
        box.logs.some((l) => l.includes('Windows')),
        '应打印一条说明平台限制的日志'
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  } else {
    // 真实非 Windows 环境：直接验证
    const { ctx, box } = makeCtx()
    let threw = null
    try { plugin.apply(ctx, {}) } catch (e) { threw = e }
    assert.equal(threw, null)
    assert.equal(box.registered, false)
  }
})

test('平台守卫：Windows 上正常注册路由', async (t) => {
  if (!IS_WINDOWS) return t.skip('仅在 Windows 上验证')
  const { ctx, box } = makeCtx()
  plugin.apply(ctx, {})
  assert.equal(box.registered, true)
  assert.equal(box.route.path, '/desktop-launcher')
  assert.equal(box.route.kind, 'prefix')
})

// ── 配置解析 ────────────────────────────────────────────────────────────────

test('配置：非法端口回落到默认值且不抛错', async (t) => {
  if (!IS_WINDOWS) return t.skip('仅在 Windows 上验证')

  for (const port of ['abc', -1, 0, 70000, null, {}]) {
    const { ctx, box } = makeCtx()
    let threw = null
    try { plugin.apply(ctx, { port }) } catch (e) { threw = e }
    assert.equal(threw, null, `port=${JSON.stringify(port)} 导致抛错`)
    assert.equal(box.registered, true, `port=${JSON.stringify(port)} 下未注册路由`)
  }
})

test('配置：合法端口被接受', async (t) => {
  if (!IS_WINDOWS) return t.skip('仅在 Windows 上验证')
  const { ctx, box } = makeCtx()
  plugin.apply(ctx, { port: 3099 })
  assert.equal(box.registered, true)
})

test('配置：不传 config 也能工作', async (t) => {
  if (!IS_WINDOWS) return t.skip('仅在 Windows 上验证')
  const { ctx, box } = makeCtx()
  assert.doesNotThrow(() => plugin.apply(ctx))
  assert.equal(box.registered, true)
})
