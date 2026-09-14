// dsh-desktop-launcher —— host 半区
//
// 职责：在 dsh webServer 上挂一个小型 API（/desktop-launcher），供浏览器半区的
// 设置面板调用，用来「生成 / 修复 / 移除」桌面快捷方式。
//
// 为什么快捷方式生成必须放在 host 侧：浏览器沙箱里没法创建 .lnk、也不该碰注册表。
// host 侧通过 powershell.exe 调用 WScript.Shell COM 完成，这是 Windows 上创建
// 快捷方式的标准做法。
//
// 注意一个刻意保留的边界：本插件只负责「让入口存在」，它不负责「启动 dsh」——
// 插件运行的前提就是 dsh 已经在跑，所以启动那一步永远属于 `.lnk` 自己。
//
// ── 平台支持 ────────────────────────────────────────────────────────────────
// 本插件**仅支持 Windows**：它依赖 .lnk 快捷方式、WScript.Shell COM、
// powershell.exe 与 %APPDATA%\npm 垫片，这些在 macOS / Linux 上都不存在。
// 在非 Windows 平台上，apply() 会**完全不注册路由**并打印一条明确的警告，
// 让 dsh 正常启动而不是抛错 —— 这是发布级插件必须做到的安全降级。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'

export const name = 'desktop-launcher'

/** 依赖 webServer 才能挂路由。 */
export const inject = ['webServer']

const ROUTE_PREFIX = '/desktop-launcher'

/** 本插件是否有能力在当前平台工作。 */
const IS_WINDOWS = process.platform === 'win32'

/** 默认服务端口（与 dsh web 的默认值一致）。 */
const DEFAULT_PORT = 3080

/**
 * 可选配置：由 profile patch 的 `config:` 传入。
 * port —— 快捷方式要连接的服务端口（默认 3080）。
 *
 * 刻意保持极简：这里只暴露「因环境而异」的值，其余路径全部由系统环境探测，
 * 不需要用户配置。
 *
 * DSH 会在加载插件时读取 `Config["~standard"].validate(...)`，所以这里必须
 * 提供标准 schema 兼容对象，而不能只导出一个普通的默认配置对象。
 */
function normalizeConfig(input = {}) {
  const out = { port: DEFAULT_PORT }
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { value: out, issues: [{ path: [], message: 'config must be an object' }] }
  }

  if (input.port !== undefined) {
    const port = normalizePort(input.port)
    if (port === undefined) {
      return {
        value: out,
        issues: [{ path: ['port'], message: 'port must be an integer between 1 and 65535' }],
      }
    }
    out.port = port
  }

  return { value: out, issues: undefined }
}

export const Config = Object.assign({
  port: DEFAULT_PORT,
}, {
  ['~standard']: {
    validate(value) {
      const result = normalizeConfig(value)
      if (result.issues?.length) return result
      return { value: result.value, issues: undefined }
    },
  },
})

/** 解析 DSH_HOME，与 dsh 自身保持一致（DSH_HOME 未必导出到 process.env）。 */
function resolveDshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  const base = process.env.USERPROFILE || process.env.HOME || ''
  return base ? join(base, '.dsh') : ''
}

/** 快捷方式、图标、启动器的落盘位置（放在用户目录下，避免污染仓库）。 */
function resolveInstallDir() {
  const home = resolveDshHome()
  return home ? join(home, 'desktop-launcher') : join(process.cwd(), '.desktop-launcher')
}

/**
 * 解析桌面目录。
 * 优先用系统 API 拿「真实」桌面路径（可能被 OneDrive 重定向），
 * 拿不到再退回 %USERPROFILE%\Desktop。
 */
function resolveDesktopDir() {
  const profile = process.env.USERPROFILE || ''
  if (!profile) return ''

  // OneDrive 重定向是常见情况，先探测它
  const onedrive = process.env.OneDrive || process.env.OneDriveConsumer
  if (onedrive) {
    const redirected = join(onedrive, 'Desktop')
    if (existsSync(redirected)) return redirected
  }

  return join(profile, 'Desktop')
}

/**
 * 在 PowerShell 里跑一段脚本，返回 stdout/stderr。
 * 用 -EncodedCommand（Base64 / UTF-16LE）传参，彻底避开引号与中文编码问题。
 */
function runPowerShell(script, timeoutMs = 60000) {
  if (!IS_WINDOWS) {
    return Promise.resolve({ code: -1, stdout: '', stderr: '当前平台不是 Windows，无法执行 PowerShell。' })
  }
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true }
    )

    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      resolve({ code: -1, stdout: out, stderr: `${err}\n[timeout after ${timeoutMs}ms]` })
    }, timeoutMs)

    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { err += String(d) })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: out, stderr: String(e && e.message ? e.message : e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: out, stderr: err })
    })
  })
}

// ── 图标生成 ────────────────────────────────────────────────────────────────
// 从 DSH 自带的 favicon.svg（黑色小鲸鱼）转出多尺寸 .ico。
// 使用 DSH profile 里已安装的 sharp，不引入新的 npm 依赖。
async function generateIcon(targetIco) {
  const srcSvg = join(
    resolveDshHome(),
    'profiles/node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon.svg'
  )
  if (!existsSync(srcSvg)) {
    return { ok: false, error: `找不到 DSH 图标源文件：${srcSvg}` }
  }

  const { createRequire } = await import('node:module')
  const profileRequire = createRequire(join(resolveDshHome(), 'profiles', 'package.json'))

  let sharp
  try {
    sharp = profileRequire('sharp')
  } catch {
    return { ok: false, error: '未找到 sharp（DSH profile 内应自带）；已跳过图标生成，快捷方式将使用系统默认图标。' }
  }

  let svg = readFileSync(srcSvg, 'utf8')
  // 去掉媒体查询：否则深色模式下鲸鱼会变白，桌面上看不清
  svg = svg.replace(/<style>[\s\S]*?<\/style>/, '')
  svg = svg.replace(/fill="#000"/g, 'fill="#000000"')

  const SIZES = [16, 24, 32, 48, 64, 128, 256]
  const frames = []
  for (const size of SIZES) {
    const buf = await sharp(Buffer.from(svg), { density: 384 })
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()
    frames.push({ size, buf })
  }

  // 手工封装 ICO 容器（sharp 不产出 ICO；ICO 可直接内嵌 PNG，Vista+ 支持）
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)

  const dir = Buffer.alloc(16 * frames.length)
  let offset = header.length + dir.length
  frames.forEach((f, i) => {
    const b = i * 16
    dir.writeUInt8(f.size >= 256 ? 0 : f.size, b + 0)
    dir.writeUInt8(f.size >= 256 ? 0 : f.size, b + 1)
    dir.writeUInt8(0, b + 2)
    dir.writeUInt8(0, b + 3)
    dir.writeUInt16LE(1, b + 4)
    dir.writeUInt16LE(32, b + 6)
    dir.writeUInt32LE(f.buf.length, b + 8)
    dir.writeUInt32LE(offset, b + 12)
    offset += f.buf.length
  })

  mkdirSync(dirname(targetIco), { recursive: true })
  writeFileSync(targetIco, Buffer.concat([header, dir, ...frames.map((f) => f.buf)]))
  return { ok: true, path: targetIco }
}

// ── 路径解析 ────────────────────────────────────────────────────────────────
function resolvePaths() {
  const installDir = resolveInstallDir()
  const desktopDir = resolveDesktopDir()
  return {
    installDir,
    desktopDir,
    launcher: join(installDir, 'dsh-launch.ps1'),
    icon: join(installDir, 'dsh-whale.ico'),
    shortcut: desktopDir ? join(desktopDir, 'DeepSeek Harness.lnk') : '',
  }
}

function psString(value) {
  // 单引号字符串：内部的单引号翻倍
  return `'${String(value).replace(/'/g, "''")}'`
}

// ── 状态查询 ────────────────────────────────────────────────────────────────
async function getStatus() {
  const p = resolvePaths()
  const script = `
$ErrorActionPreference = 'Stop'
$o = [ordered]@{}
$o.shortcutExists = Test-Path ${psString(p.shortcut)}
$o.launcherExists = Test-Path ${psString(p.launcher)}
$o.iconExists     = Test-Path ${psString(p.icon)}
$o.desktop        = ${psString(p.shortcut)}
if ($o.shortcutExists) {
  try {
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut(${psString(p.shortcut)})
    $o.target = $sc.TargetPath
    $o.arguments = $sc.Arguments
    $o.icon = $sc.IconLocation
  } catch { $o.readError = $_.Exception.Message }
}
$o | ConvertTo-Json -Compress
`
  const r = await runPowerShell(script)
  if (r.code !== 0) return { ok: false, error: r.stderr || 'PowerShell 执行失败' }
  try {
    return { ok: true, ...JSON.parse(r.stdout.trim()) }
  } catch {
    return { ok: false, error: `无法解析状态输出：${r.stdout}` }
  }
}

// ── 生成 / 修复快捷方式 ─────────────────────────────────────────────────────
async function install(options = {}) {
  const p = resolvePaths()
  const port = Number(options.port) || DEFAULT_PORT
  const workDir = options.workDir || resolveDefaultWorkDir()
  const useIcon = options.useIcon !== false

  if (!p.shortcut) {
    return { ok: false, error: '无法解析桌面目录，请检查 USERPROFILE 环境变量。' }
  }

  mkdirSync(p.installDir, { recursive: true })

  // 1) 图标（失败不致命，退回系统默认图标）
  let iconWarning = ''
  if (useIcon) {
    const icon = await generateIcon(p.icon)
    if (!icon.ok) iconWarning = icon.error
  }

  // 2) 启动器脚本
  const launcherPs1 = buildLauncherScript({ port, workDir })
  writeFileSync(p.launcher, '\ufeff' + launcherPs1, 'utf8')

  // 3) 快捷方式：目标是 powershell.exe，隐藏窗口运行启动器
  const iconArg = useIcon && existsSync(p.icon) ? `${p.icon},0` : ''
  const powershellExe = join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
  )

  const script = `
$ErrorActionPreference = 'Stop'
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut(${psString(p.shortcut)})
$sc.TargetPath       = ${psString(powershellExe)}
$sc.Arguments        = ${psString(`-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${p.launcher}"`)}
$sc.WorkingDirectory = ${psString(workDir)}
${iconArg ? `$sc.IconLocation = ${psString(iconArg)}` : ''}
$sc.Description      = 'DeepSeek Harness Web GUI'
$sc.WindowStyle      = 7
$sc.Save()

# 刷新 Explorer 图标缓存，让新图标立刻生效
Add-Type -Namespace W32 -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, int f, IntPtr a, IntPtr b);'
[W32.Shell]::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero)

Write-Output 'OK'
`
  const r = await runPowerShell(script)
  if (r.code !== 0 || !r.stdout.includes('OK')) {
    return { ok: false, error: r.stderr || '创建快捷方式失败' }
  }

  const status = await getStatus()
  return { ok: true, ...status, warning: iconWarning }
}

/** 生成启动器脚本正文（与手写版本同逻辑，只是端口/路径参数化）。 */
function buildLauncherScript({ port, workDir }) {
  const { candidates, whereExe } = resolveDshCommand()
  const shimCandidates = candidates.map((p) => psString(p)).join(', ')
  const whereCommand = psString(whereExe)
  return `# 由 dsh-desktop-launcher 插件生成 —— 不要手工编辑，会被覆盖。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$Port    = ${port}
$Host_   = '127.0.0.1'
$Url     = "http://\${Host_}:$Port"
$WorkDir = ${psString(workDir)}
$LogFile = Join-Path $env:TEMP "dsh-web-$Port.log"
$ErrFile = Join-Path $env:TEMP "dsh-web-$Port.err.log"
$WhereExe = ${whereCommand}
$ShimCandidates = @(${shimCandidates})

function Resolve-DshShim {
    foreach ($candidate in $ShimCandidates) {
        if (Test-Path $candidate) { return $candidate }
    }

    try {
        $whereResult = & $WhereExe dsh 2>$null
        if ($LASTEXITCODE -eq 0 -and $whereResult) {
            return ($whereResult | Select-Object -First 1)
        }
    } catch {}

    return $null
}

function Test-DshUp {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2 -ErrorAction Stop
        return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
    } catch {
        return $false
    }
}

# 传 URL 给 Start-Process 会走 ShellExecute，交给系统默认浏览器
function Open-DefaultBrowser {
    param([string]$Target)
    try { Start-Process $Target }
    catch { Start-Process -FilePath 'rundll32.exe' -ArgumentList 'url.dll,FileProtocolHandler', $Target }
}

if (Test-DshUp) { Open-DefaultBrowser $Url; exit 0 }

Remove-Item $LogFile, $ErrFile -ErrorAction SilentlyContinue
$Shim = Resolve-DshShim
if (-not $Shim) {
    [System.Windows.Forms.MessageBox]::Show("找不到 dsh 命令。已尝试：$($ShimCandidates -join '; ')\`n请先执行 npm i -g @deepseek-ai/dsh", 'DSH 启动失败') | Out-Null
    exit 1
}

Start-Process -FilePath $env:ComSpec \`
    -ArgumentList @('/c', "\`"$Shim\`"", 'web', '--port', "$Port", '--host', $Host_) \`
    -WorkingDirectory $WorkDir -WindowStyle Hidden \`
    -RedirectStandardOutput $LogFile -RedirectStandardError $ErrFile | Out-Null

$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
    if (Test-DshUp) { Start-Sleep -Milliseconds 500; Open-DefaultBrowser $Url; exit 0 }
    Start-Sleep -Milliseconds 400
}

$detail = ''
if (Test-Path $ErrFile) { $detail = (Get-Content $ErrFile -Tail 15 -ErrorAction SilentlyContinue) -join "\`n" }
[System.Windows.Forms.MessageBox]::Show("DeepSeek Harness 启动超时。\`n\`n日志：$LogFile\`n$ErrFile\`n\`n$detail", 'DSH 启动失败') | Out-Null
`
}

// ── 移除快捷方式 ────────────────────────────────────────────────────────────
async function uninstall() {
  const p = resolvePaths()
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Remove-Item ${psString(p.shortcut)} -Force
Remove-Item ${psString(p.launcher)} -Force
Remove-Item ${psString(p.icon)} -Force
Write-Output 'OK'
`
  const r = await runPowerShell(script)
  if (r.code !== 0) return { ok: false, error: r.stderr }
  return { ok: true, ...(await getStatus()) }
}

// ── 路由 ────────────────────────────────────────────────────────────────────
/**
 * 读取请求体。
 *
 * 返回 { ok: true, text } 或 { ok: false } —— **必须区分「空 body」与「超限」**。
 * 早先的实现两者都返回 ''，导致超限请求被静默降级成默认参数后继续执行
 * install()（实测确认会真的开始写图标文件），这是一个真实的输入处理缺陷。
 *
 * 超限时返回 ok:false，由调用方回 413，绝不继续执行副作用。
 */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    let settled = false
    const chunks = []
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        done({ ok: false })          // 明确标记超限，不再是 ''（空 body）
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => done({ ok: true, text: Buffer.concat(chunks).toString('utf8') }))
    req.on('error', () => done({ ok: false }))
  })
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

// ── 安全围栏 ────────────────────────────────────────────────────────────────
//
// 为什么需要它：dsh 的 webserver 只做「匹配路由 → 调 handler」，**不做任何
// Origin / Host 校验**；官方的信任围栏（isTrustedApiRequest）只包在 /api 那一条
// 链路上。插件自定义路由默认完全没有保护 —— 实测确认：
//   Host 伪造为 LAN 地址  → /api 返回 403（围栏生效）
//                          /desktop-launcher 返回 200（无围栏）
// 而本插件的接口会**执行 PowerShell**，所以必须自己补上这道围栏。
//
// 威胁模型：本机浏览器里打开的任意恶意网页（CSRF）。攻击者读不到响应
// （我们不返回 CORS 头），但可以「盲发」请求触发副作用。
// 由于服务只绑定 127.0.0.1，跨机攻击不成立，主要风险就是同机浏览器。

/** loopback 判定：localhost、IPv6 ::1、以及整个 127.0.0.0/8。 */
function isLoopbackHostname(hostname) {
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '::1') return true
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (m === null) return false
  return m.slice(1).every((part) => Number(part) <= 255)
}

/** 解析 authority（host 或 host:port），失败返回 undefined。 */
function parseAuthority(value) {
  try {
    return new URL(`http://${String(value)}`)
  } catch {
    return undefined
  }
}

/**
 * 本插件的请求准入判定，语义对齐官方的 isTrustedApiRequest：
 *   1) Host 必须是 loopback（本部署仅本机服务，不接受 LAN authority）；
 *   2) 带 Sec-Fetch-Site: cross-site 的请求一律拒绝（浏览器明确标注跨站）；
 *   3) Origin 存在时必须与 Host 同源 —— 这正是 CSRF 的关键闸门。
 * 只在 127.0.0.1 上监听，因此不引入 trustedHosts 概念。
 */
function isTrustedRequest(req) {
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return false

  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname)) return false

  const fetchSite = req.headers?.['sec-fetch-site']
  if (fetchSite === 'cross-site') return false

  const origin = req.headers?.origin
  if (origin === undefined) return true          // 非浏览器请求（curl/脚本）
  try {
    return new URL(origin).host === hostUrl.host // 浏览器请求必须同源
  } catch {
    return false
  }
}

/** 端口白名单：只接受 1–65535 的整数。 */
function normalizePort(value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined
  return n
}

/**
 * 工作目录校验：必须是已存在的绝对路径。
 * 这不能阻止「用户主动填任意路径」（那是用户自己的选择），但能挡住
 * 明显畸形的输入，且该值最终只作为单引号字面量写入 PowerShell。
 */
function normalizeWorkDir(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  if (!/^[a-zA-Z]:[\\/]/.test(value) && !value.startsWith('\\\\')) return undefined
  return value
}

function resolveDshCommand() {
  const candidates = []

  const appData = process.env.APPDATA || ''
  if (appData) candidates.push(join(appData, 'npm', 'dsh.cmd'))

  const whereExe = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'where.exe') : 'where.exe'
  candidates.push(whereExe)

  return { candidates, whereExe }
}

function resolveDefaultWorkDir() {
  const likely = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  if (likely && typeof likely === 'string' && likely.trim()) return likely
  return process.cwd()
}

export function apply(ctx, config = {}) {
  // ── 平台守卫 ──────────────────────────────────────────────────────────────
  // 非 Windows 上**完全不注册路由**。理由：本插件的每一步（.lnk、WScript.Shell、
  // powershell.exe、%APPDATA%\npm 垫片）都只存在于 Windows；在这些平台上挂出
  // 一个必然失败的路由，只会让用户看到一堆莫名其妙的错误。
  // 安全降级 = dsh 照常启动，插件安静地不提供服务，并说明原因。
  if (!IS_WINDOWS) {
    ctx.logger?.info?.(
      '[desktop-launcher] 当前平台不是 Windows（' + process.platform + '），' +
      '本插件依赖 Windows 快捷方式（.lnk / WScript.Shell / powershell.exe），' +
      '已跳过路由注册；插件其余部分不影响 dsh 运行。'
    )
    return
  }

  // 配置端口：非法值一律回落到默认值，绝不让坏配置变成坏脚本
  const configuredPort = normalizePort(config?.port) ?? DEFAULT_PORT
  const defaultWorkDir = resolveDefaultWorkDir()

  ctx.effect(() => {
    const handler = async (req, res) => {
      // 围栏先于一切副作用：未通过则直接 403，不解析、不执行
      if (!isTrustedRequest(req)) {
        return sendJson(res, 403, { ok: false, error: '请求被拒绝：非本机同源来源。' })
      }

      const url = new URL(req.url ?? '/', 'http://localhost')
      const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')

      try {
        if (req.method === 'GET' && (action === '' || action === 'status')) {
          return sendJson(res, 200, await getStatus())
        }

        if (req.method === 'POST' && action === 'install') {
          const bodyResult = await readBody(req)
          if (!bodyResult.ok) {
            return sendJson(res, 413, { ok: false, error: '请求体过大或读取失败，已拒绝。' })
          }

          let input = {}
          if (bodyResult.text) {
            try { input = JSON.parse(bodyResult.text) } catch {
              return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON。' })
            }
          }
          // 空请求体是合法的：全部走默认值
          if (input === null || typeof input !== 'object' || Array.isArray(input)) {
            return sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象。' })
          }

          // 显式白名单构造 options，绝不把请求体原样透传进 install()
          const options = { port: configuredPort, workDir: defaultWorkDir, useIcon: true }

          if (input.port !== undefined) {
            const port = normalizePort(input.port)
            if (port === undefined) {
              return sendJson(res, 400, { ok: false, error: '端口必须是 1–65535 的整数。' })
            }
            options.port = port
          }

          if (input.workDir !== undefined) {
            const workDir = normalizeWorkDir(input.workDir)
            if (workDir === undefined) {
              return sendJson(res, 400, { ok: false, error: '工作目录必须是绝对路径。' })
            }
            options.workDir = workDir
          }

          if (input.useIcon !== undefined) options.useIcon = input.useIcon !== false

          const result = await install(options)
          return sendJson(res, result.ok ? 200 : 500, result)
        }

        if (req.method === 'POST' && action === 'uninstall') {
          const result = await uninstall()
          return sendJson(res, result.ok ? 200 : 500, result)
        }

        return sendJson(res, 404, { ok: false, error: `未知操作：${action || '(空)'}` })
      } catch (error) {
        ctx.logger?.warn?.(error)
        return sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
      }
    }

    return ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
  }, 'desktop-launcher: /desktop-launcher routes')
}
