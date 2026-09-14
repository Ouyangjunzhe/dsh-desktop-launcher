// 安全测试：信任围栏 + 输入校验 + 命令注入防护。
//
// 这些用例对应两个**真实修复过的漏洞**，请勿删除：
//   1. 无信任围栏 —— 伪造 LAN Host / 跨站 Origin 曾能触发 PowerShell 执行；
//   2. 超限 body 静默降级 —— >64KB 的请求体曾被当成空 body，绕过校验后继续执行。
//
// 运行：node --test test/   或   npm test

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { loadPlugin, makeCtx, call, SAME_ORIGIN } from './helpers.mjs'

const plugin = await loadPlugin()

/** 建一个已 apply 的 handler。 */
function setup(config = {}) {
  const { ctx, box } = makeCtx()
  plugin.apply(ctx, config)
  return box
}

// ── 信任围栏 ────────────────────────────────────────────────────────────────

test('围栏：拒绝伪造的 LAN Host（曾可触发 PowerShell 执行）', async () => {
  const box = setup()
  const r = await call(box, {
    url: '/desktop-launcher/status',
    headers: { host: '192.168.1.50:3080', origin: 'http://192.168.1.50:3080' },
  })
  assert.equal(r.code, 403)
})

test('围栏：拒绝跨站 Origin（CSRF）', async () => {
  const box = setup()
  const r = await call(box, {
    url: '/desktop-launcher/status',
    headers: { host: '127.0.0.1:3080', origin: 'https://evil.example.com' },
  })
  assert.equal(r.code, 403)
})

test('围栏：拒绝 Sec-Fetch-Site: cross-site', async () => {
  const box = setup()
  const r = await call(box, {
    url: '/desktop-launcher/status',
    headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site', origin: 'http://127.0.0.1:3080' },
  })
  assert.equal(r.code, 403)
})

test('围栏：拒绝缺失 Host', async () => {
  const box = setup()
  const r = await call(box, { url: '/desktop-launcher/status', headers: {} })
  assert.equal(r.code, 403)
})

test('围栏：拒绝公网域名 Host', async () => {
  const box = setup()
  const r = await call(box, { url: '/desktop-launcher/status', headers: { host: 'evil.com:3080' } })
  assert.equal(r.code, 403)
})

test('围栏：拒绝 localhost Host 但外部 Origin', async () => {
  const box = setup()
  const r = await call(box, {
    url: '/desktop-launcher/status',
    headers: { host: 'localhost:3080', origin: 'http://attacker.test' },
  })
  assert.equal(r.code, 403)
})

test('围栏：拒绝畸形 Host', async () => {
  const box = setup()
  const r = await call(box, { url: '/desktop-launcher/status', headers: { host: ':::bad:::' } })
  assert.equal(r.code, 403)
})

test('围栏：放行同源浏览器请求', async () => {
  const box = setup()
  const r = await call(box, { url: '/desktop-launcher/status', headers: SAME_ORIGIN })
  assert.notEqual(r.code, 403, '同源请求被误拦')
})

test('围栏：放行 localhost 同源', async () => {
  const box = setup()
  const r = await call(box, {
    url: '/desktop-launcher/status',
    headers: { host: 'localhost:3080', origin: 'http://localhost:3080' },
  })
  assert.notEqual(r.code, 403)
})

test('围栏：放行无 Origin 的本机脚本请求', async () => {
  const box = setup()
  const r = await call(box, { url: '/desktop-launcher/status', headers: { host: '127.0.0.1:3080' } })
  assert.notEqual(r.code, 403)
})

test('围栏：127.0.0.0/8 全部视为 loopback', async () => {
  const box = setup()
  for (const host of ['127.0.0.1:3080', '127.1.2.3:3080', '127.255.255.255:3080']) {
    const r = await call(box, { url: '/desktop-launcher/status', headers: { host } })
    assert.notEqual(r.code, 403, `${host} 被误拦`)
  }
})

// ── 输入校验 ────────────────────────────────────────────────────────────────

test('校验：端口越界被拒', async () => {
  const box = setup()
  for (const port of [0, -1, 65536, 99999]) {
    const r = await call(box, {
      method: 'POST', url: '/desktop-launcher/install', headers: SAME_ORIGIN,
      body: JSON.stringify({ port }),
    })
    assert.equal(r.code, 400, `port=${port} 未被拒`)
  }
})

test('校验：非整数端口被拒', async () => {
  const box = setup()
  for (const port of [1.5, 'abc', null, {}, []]) {
    const r = await call(box, {
      method: 'POST', url: '/desktop-launcher/install', headers: SAME_ORIGIN,
      body: JSON.stringify({ port }),
    })
    assert.equal(r.code, 400, `port=${JSON.stringify(port)} 未被拒`)
  }
})

test('校验：workDir 必须是绝对路径', async () => {
  const box = setup()
  for (const workDir of ['rel/path', './x', '', '   ', 42]) {
    const r = await call(box, {
      method: 'POST', url: '/desktop-launcher/install', headers: SAME_ORIGIN,
      body: JSON.stringify({ workDir }),
    })
    assert.equal(r.code, 400, `workDir=${JSON.stringify(workDir)} 未被拒`)
  }
})

test('校验：超大 body 返回 413 而非静默降级（曾绕过校验）', async () => {
  const box = setup()
  const huge = JSON.stringify({ workDir: 'C:\\' + 'A'.repeat(70 * 1024) })
  const r = await call(box, {
    method: 'POST', url: '/desktop-launcher/install', headers: SAME_ORIGIN, body: huge,
  })
  assert.equal(r.code, 413, '超大 body 未被拒 —— 回归！')
})

test('校验：非法 JSON 被拒', async () => {
  const box = setup()
  const r = await call(box, {
    method: 'POST', url: '/desktop-launcher/install', headers: SAME_ORIGIN, body: '{oops',
  })
  assert.equal(r.code, 400)
})

test('校验：非对象 JSON 被拒', async () => {
  const box = setup()
  for (const body of ['[1,2]', '"str"', '42', 'null', 'true']) {
    const r = await call(box, {
      method: 'POST', url: '/desktop-launcher/install', headers: SAME_ORIGIN, body,
    })
    assert.equal(r.code, 400, `body=${body} 未被拒`)
  }
})

test('校验：未知 action 返回 404', async () => {
  const box = setup()
  const r = await call(box, { url: '/desktop-launcher/nope', headers: SAME_ORIGIN })
  assert.equal(r.code, 404)
})

test('校验：GET 不接受 install（方法约束）', async () => {
  const box = setup()
  const r = await call(box, { method: 'GET', url: '/desktop-launcher/install', headers: SAME_ORIGIN })
  assert.equal(r.code, 404)
})

// ── 命令注入防护（纯逻辑，不执行 PowerShell）─────────────────────────────────

test('注入：单引号转义往返一致，无命令注入', async () => {
  // 与 index.js 中 psString 等价的实现；此处验证转义语义本身
  const psString = (v) => `'${String(v).replace(/'/g, "''")}'`
  const unquote = (lit) => lit.slice(1, -1).replace(/''/g, "'")

  const payloads = [
    "C:\\x'; Remove-Item C:\\ -Recurse; '",
    'C:\\x`; whoami',
    'C:\\$env:USERPROFILE',
    'C:\\a; Start-Process calc',
    'C:\\a\nWrite-Output PWNED',
    'C:\\$(Get-Process)',
    'C:\\a"b',
    "''''",
    "'",
  ]

  for (const p of payloads) {
    const lit = psString(p)
    assert.ok(lit.startsWith("'") && lit.endsWith("'"), `未成为完整字面量: ${lit}`)
    assert.equal(unquote(lit), p, `往返不一致: ${JSON.stringify(p)}`)
  }
})
