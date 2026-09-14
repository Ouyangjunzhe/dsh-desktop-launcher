# Contributing

Thanks for looking. This plugin executes PowerShell, so the bar for changes is a
little higher than usual — please read the invariants below before touching
`index.js`.

## Setup

```bash
git clone <your-fork>
cd dsh-desktop-launcher
npm test
```

There are **no dependencies** — the plugin uses only Node built-ins plus the
`sharp` that DSH already ships. Nothing to install.

## Project layout

| File | Role |
|---|---|
| `index.js` | Host half — registers the `/desktop-launcher` routes, generates the shortcut, icon, and launcher script |
| `client.js` | Browser half — the **Settings → Desktop Launcher** panel |
| `test/` | Node built-in test runner suites |
| `test/helpers.mjs` | Fake Cordis context + HTTP-level request driver |

## Security invariants — please do not weaken these

Two real vulnerabilities were found and fixed during development. The test suite
guards both; read these before changing request handling.

### 1. Every route needs its own trust fence

DSH's webserver dispatches a matched route straight to its handler and performs
**no `Host` or `Origin` validation**. The framework's trust fence
(`isTrustedApiRequest`) only wraps the official `/api` path. A plugin route with
no fence is reachable from any web page open in the user's browser.

Verified behaviour on a stock install:

```
forged LAN Host  →  /api                 403   (fence works)
forged LAN Host  →  /desktop-launcher    200   (no fence — this plugin)
forged LAN Host  →  /ide/  (third party) 200   (no fence)
```

So `isTrustedRequest()` in `index.js` is not optional. It rejects non-loopback
`Host`, cross-site `Origin`, and `Sec-Fetch-Site: cross-site`.

### 2. Never continue after a failed body read

The original `readBody()` returned `''` for both "empty body" and "body too
large". The caller could not tell them apart, so a >64 KB request was silently
downgraded to default parameters and **continued into `install()`** — input
validation could be bypassed simply by sending a large payload.

`readBody()` now returns `{ ok: true, text }` or `{ ok: false }`, and every
failure path returns a 4xx **before** any side effect runs.

### 3. Quote everything that reaches PowerShell

All external values pass through `psString()`, which wraps them in a PowerShell
single-quoted literal with internal quotes doubled. Single-quoted strings are
verbatim — `$`, backticks, `;`, and newlines are not interpreted. Do not
interpolate raw values into script text.

## Platform

The plugin is **Windows-only**. `package.json` declares `"os": ["win32"]`, and
`apply()` returns early on other platforms without registering routes. Keep it
that way: a registered route that can only fail produces confusing errors for
users on macOS and Linux, whereas a silent skip plus one log line does not.

## Adding tests

Use the Node built-in runner (`node:test`). `test/helpers.mjs` gives you a fake
Cordis context and an HTTP-level `call()`:

```js
import { loadPlugin, makeCtx, call, SAME_ORIGIN } from './helpers.mjs'
const plugin = await loadPlugin()

const { ctx, box } = makeCtx()
plugin.apply(ctx, {})

const r = await call(box, {
  method: 'POST',
  url: '/desktop-launcher/install',
  headers: SAME_ORIGIN,
  body: JSON.stringify({ port: 99999 }),
})
assert.equal(r.code, 400)
```

**A note on `call()` internals:** it fires the request body events via
`setImmediate` and awaits the handler concurrently. Awaiting the handler *before*
delivering the body deadlocks every POST, because `readBody()` waits for `end`
while the handler is still waiting for `readBody()`. If POST tests hang, that's
why.

Anything that shells out to PowerShell should be guarded with `IS_WINDOWS` so
the suite stays green on CI's Linux runner.

## Local install for manual testing

Copy the directory into your DSH profile and register it:

```powershell
Copy-Item . "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-desktop-launcher" -Recurse -Force
```

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- insert:
    - id: desktop-launcher
      name: 'dsh-desktop-launcher'
```

Then **restart dsh** — plugins are scanned at process start, so reloading the
browser is not enough.

## License

MIT — see [LICENSE](./LICENSE).
