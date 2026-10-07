# devport

See every dev server running on your Windows machine, which project it belongs to, and stop it in one click.

![devport dashboard](docs/screenshot.png)

You start `npm run dev` in one terminal, a Python server in another, forget about both, and two days later port 5173 is taken and something on 3000 is eating 400 MB. devport is a small local dashboard that answers "what is running, and from where?" without `netstat` and Task Manager.

## What it shows

- **Every listening dev server.** It scans all ports, not a fixed list, and refreshes every 3 seconds. It pauses while the tab is hidden.
- **The project it came from.** The repo folder is read from the process command line, so `...\projects\acme-storefront\node_modules\vite\bin\vite.js` shows as **acme-storefront**.
- **The stack.** Vite, Astro, Next.js, Nuxt, Remix, Angular, Webpack, Wrangler, Netlify Dev, `serve`, `http-server`, nodemon, tsx, Python `http.server`, Uvicorn, Flask, Django, Laravel, PHP's built-in server and Rails.
- **Uptime and memory.** Servers running longer than 8 hours are highlighted.
- **Binding.** `localhost`, `IPv6 only` (`::1`, where `127.0.0.1` won't connect) or `LAN visible` (reachable from other devices on your network).
- **Actions.** Open in the browser, open the folder in Explorer, open it in VS Code, **Stop**, and **Stop all**. Stopping takes a second click to confirm and ends the whole process tree.

Everything else listening on your machine (system services, Steam, Zoom, editor extensions, AI tools) is listed under **Other listeners**, read-only. devport only stops processes running on a dev runtime (`node`, `python`, `php`, `bun`, `deno`, `ruby`). It never stops:

- Windows services or desktop apps
- editor extension hosts (VS Code, Cursor)
- MCP servers and agent tooling (Hermes, Antigravity)
- itself

## Requirements

- Windows 10 or 11 (it uses `netstat`, `taskkill` and PowerShell's CIM)
- Node.js 20 or newer
- No dependencies, no install step

## Run it

```bash
git clone https://github.com/kingspast21/devport.git
cd devport
npm start
```

Then open http://localhost:7777.

### Options

| Variable | Default | What it does |
|---|---|---|
| `DEVPORT_PORT` | `7777` | Port the dashboard listens on |
| `DEVPORT_ROOT` | `~/projects` | Folder your repos live in |

Repos directly inside the root are listed by folder name. Repos inside a `work` subfolder (`~/projects/work/<repo>`) get a **work** tag, which helps keep client or employer projects apart. A server whose path is outside the root is still detected, from the folder that holds its `node_modules`, and is tagged **outside projects**.

## How it works

1. `netstat -ano` lists listening TCP ports and their process IDs.
2. A long-lived PowerShell worker asks CIM (`Win32_Process`) for each process's command line, start time and memory. Reusing one worker keeps a scan to about half a second after the first one.
3. `lib/classify.js` sorts each process into dev server, tooling, app or system, and works out the repo and stack. It is pure and covered by tests: `npm test`.
4. Before stopping or opening anything, the server scans again and only acts on a PID that is still a dev server, so a recycled PID can't be hit by mistake.

## Security

devport can end processes, so it is locked down:

- It binds to `127.0.0.1` only.
- Requests with a foreign `Host` header are refused, which blocks DNS rebinding.
- Every action needs a same-origin request with a custom header, so other websites can't trigger it.

There is no auth beyond that. Don't expose it on a network.

## Limits

- **Windows only** for now. macOS and Linux would need `lsof`/`ss` and `ps` in `lib/scan.js`. PRs welcome.
- **Repos are found from the command line.** A server started with no path in its arguments (for example `python -m http.server` run from inside the repo) shows as **Unknown repo**, because Windows doesn't expose another process's working directory without native code.
- **Open in VS Code** expects the default user install of VS Code.

## License

MIT
