# dsh-phone-bridge

Drive an existing DeepSeek Harness **desktop** session from a chat app, and manage
sessions from the sidebar.

> **Status as of October 2026:** DSH ships no way to reach a running desktop session
> from a phone, and no delete button. This package fills both gaps. It is unofficial
> and may break when DSH changes.

## Install

```powershell
dsh plugin --profile desktop add dsh-phone-bridge
```

Then restart DSH. The package carries its own `dsh.bundle.patch`, so no config file
has to be edited by hand.

## What it adds

**Desktop UI** — a delete button on every session row (with a confirmation), and a
trash panel at the bottom of the sidebar where each entry can be restored or purged.

**HTTP routes** under `/phone-bridge/*`, for a chat-side client to call:

| Route | Purpose |
|---|---|
| `GET /sessions` | list sessions, the same set the sidebar shows |
| `GET /search?q=` | search session message content |
| `POST /create` | create a session |
| `POST /rename` | set a session title |
| `POST /delete` | move a session to the trash |
| `GET /trash` | list the trash and its size |
| `POST /restore` | put a trashed session back |
| `POST /purge` | erase trashed data permanently |
| `GET /status` | running state, working directory, last activity |
| `POST /stop` | cancel the session's running turn |
| `GET /models` | the deployment model catalog |
| `POST /model` | switch the model a session uses |

Deleting **moves** a session to `~/.dsh/deleted-sessions/` instead of unlinking it,
so a delete stays recoverable and purging is a separate, explicit step.

## The chat side

This package is only the DSH half. To talk to it from WeChat, Telegram or Yuanbao
you also need the OpenClaw plugin:

```powershell
openclaw plugins install openclaw-dsh-bridge --force --accept-capabilities
```

Both flags are required and the error does not say which one is missing. `--force`
because the package lives on npm rather than OpenClaw's own ClawHub, and
`--accept-capabilities` because the plugin declares capabilities.

Make sure `~/.openclaw/extensions/` holds no second copy of the plugin: OpenClaw
loads every subdirectory there that carries an `openclaw.plugin.json`, so a stale
backup folder gets loaded too, and two copies sharing one id forward every message
twice.

Source and setup guide: <https://github.com/KaiyeZeng/dsh-phone-bridge>

## Notes

- **Zero runtime dependencies.** Only `node:` builtins are imported, so the file can
  be mounted straight from disk with `file://` and no `node_modules` directory.
- `/sessions` reads DSH's workspace registry rather than the disk, so the phone lists
  what the desktop sidebar lists. Sessions that were never registered in a workspace
  (subagent sessions, ones made before the registry existed) have files but no
  sidebar row, and listing the disk alone made the phone show rows the desktop did
  not have.
- The model catalog is read structurally. The exact shape is not a stable surface, so
  a change there shortens the list instead of crashing.

MIT licensed.
