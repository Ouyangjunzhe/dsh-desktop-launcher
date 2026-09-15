# dsh-desktop-launcher

A Windows desktop launcher plugin for DSH that creates a shortcut and startup launcher for quick one-click access.

<p align="center">
  <img src="https://raw.githubusercontent.com/Ouyangjunzhe/dsh-desktop-launcher/main/docs/settings.png" alt="Settings panel" width="900" />
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Ouyangjunzhe/dsh-desktop-launcher/main/docs/shortcut.png" alt="Desktop shortcut" width="900" />
</p>

> **Windows only.** The plugin relies on `.lnk` shortcuts, `WScript.Shell` COM, `powershell.exe`, and the `%APPDATA%\npm` shim; none of these exist on macOS or Linux. On other platforms it degrades safely — no routes are registered and one explanatory line is logged — so dsh keeps starting normally.

---

## The problem it solves

Starting DSH normally means typing `dsh web` in a terminal and then opening the browser yourself. This plugin adds a **Settings → Desktop Launcher** panel that generates a desktop shortcut: **double-click → service starts hidden → your default browser opens.**

It also regenerates the shortcut when you change ports, repairs a broken icon, and removes everything when you're done.

## What it does *not* do — and can't

The plugin runs **inside** the dsh process, so it cannot replace the shortcut:

- the **shortcut** starts dsh — the plugin cannot, because the plugin only exists once dsh is already running;
- the **plugin** maintains that shortcut — making its creation and updates repeatable.

Those two roles can't be merged. If what you want is "double-click to start", the shortcut *is* the feature; the plugin just keeps it in sync with your configuration.

---

## Install

```bash
dsh plugin --profile web add dsh-desktop-launcher
```

Or place the directory in your profile's `node_modules` and register it in `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: desktop-launcher
      name: 'dsh-desktop-launcher'
```

Then **restart dsh** — plugins are scanned at process start, so reloading the browser is not enough.

### Configuration

Set the port if it differs from the default (must match what `dsh web` actually listens on):

```yaml
- insert:
    - id: desktop-launcher
      name: 'dsh-desktop-launcher'
      config:
        port: 3080
```

---

## Usage

Open **Settings → Desktop Launcher**:

| Action | Effect |
|---|---|
| Generate | Creates the `.lnk`, plus the icon and launcher script |
| Repair | Use after changing ports, or if the icon or script got damaged |
| Remove | Deletes the `.lnk`, launcher script, and icon |
| Refresh | Re-reads the real on-disk state |

### Files it creates

| Path | Content |
|---|---|
| `Desktop\DeepSeek Harness.lnk` | The shortcut (OneDrive-redirected desktops are detected) |
| `$DSH_HOME/desktop-launcher/dsh-launch.ps1` | The launcher script |
| `$DSH_HOME/desktop-launcher/dsh-whale.ico` | 7-size icon (16/24/32/48/64/128/256) |

The icon is converted on demand from the `favicon.svg` that ships with DSH (black whale, transparent background) using the `sharp` already present in the profile — **no extra dependencies**.

---

## Security

This plugin executes PowerShell, so its endpoints are fenced:

- **Trust fence** — rejects non-loopback `Host`, cross-site `Origin`, and `Sec-Fetch-Site: cross-site` (CSRF defence). DSH's webserver performs **no** `Host`/`Origin` validation for plugin routes; the framework's fence only covers `/api`. Each plugin must therefore guard its own routes.
- **Input allowlist** — the request body is validated and parameters are reconstructed explicitly. Ports must be integers in 1–65535, working directories must be absolute; oversized bodies, malformed JSON, and non-object payloads are rejected **before any side effect runs**.
- **Command construction** — every external value passes through `psString()`, becoming a PowerShell single-quoted literal with internal quotes doubled. Single-quoted strings are verbatim: `$`, backticks, `;`, and newlines are not interpreted.
- **Loopback only** — dsh binds `127.0.0.1`, so the API is not reachable from other machines.

### Known boundaries

- Any process that can reach local port 3080 may call these endpoints. This matches dsh's local-trust model, but is worth knowing.
- The working directory is user-chosen among valid absolute paths; it is not restricted to an allowlist.

### History

Two vulnerabilities were found and fixed during development, both now covered by regression tests:

1. **Missing trust fence** — a forged LAN `Host` or cross-site `Origin` could trigger PowerShell execution.
2. **Silent downgrade on oversized bodies** — a >64 KB body was treated as empty, bypassing validation and continuing into `install()`.

---

## Development

```bash
npm test
```

29 tests, no dependencies (Node built-in runner only). See [CONTRIBUTING.md](./CONTRIBUTING.md) for the security invariants you must preserve when changing request handling.

---

## Uninstall

Click **Remove** in the panel, then delete the entry from `cordis.patch.yml` and restart dsh.

---

## License

[MIT](./LICENSE)
