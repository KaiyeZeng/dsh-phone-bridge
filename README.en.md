# dsh-phone-bridge

**Pick up the DSH session you are already running on your desktop, from your phone.**

This is not another chat bot for DSH. It lets you switch into an **existing
desktop session** from a chat app, see where it got to, and keep talking in it.

English | [中文](README.md)

---

## How this differs from other DSH phone setups

Most existing projects add a **new chat entry point** to DSH: the bot creates its
own session under a working directory, and what you say on the phone lives in a
different conversation from the ones in the desktop sidebar. The two contexts do
not meet.

This project does the other thing: the list on your phone **is** the list of
sessions on your desktop. You can switch, search, rename and delete them, and
what you say lands in that very session, so opening it on the desktop continues
the same context.

| | Typical setup | This project |
|---|---|---|
| Whose session | created by the bot | **the real desktop session** |
| Can you choose a session on the phone | no | **yes** (list / switch / search) |
| Context shared with the desktop | two separate ones | **the same one** |
| Session management | only "new session" | list / switch / search / rename / delete / trash |
| Access control | varies | **allowlist** of chat account ids |

## Layout

Two plugins, one repository, **both required**:

```
chat app ──► OpenClaw ──► openclaw-plugin ──HTTP──► dsh-plugin ──► desktop session
                │                                        │
                └──────────── questions / approvals ──────┘
```

| Directory | Installed in | Role |
|---|---|---|
| [`openclaw-plugin/`](openclaw-plugin/) | OpenClaw | Intercepts chat messages, turns them into HTTP calls, and carries pending questions and approvals back to the chat |
| [`dsh-plugin/`](dsh-plugin/) | DSH desktop | Exposes loopback routes that drive the real `sessionController` |

**Why the DSH half is mandatory**: `dsh --profile headless` refuses any session
that carries an agent preset (`if (preset !== void 0) throw` is hard-coded), so
driving a desktop session from outside the process is a dead end. Running inside
the desktop process puts the real `sessionController` within reach.

## Commands

**On the phone**

- `/list [page]` — list desktop sessions
- `/use <n>` — switch to a session
- `/where` — which session is current
- `/find <word>` — search titles; `/find-any <word>` searches message bodies too
- `/new` — create a session
- `/name <title>` — rename
- `/status` — state of the current session, its working directory, last activity
- `/stop` — stop the running turn (queued messages are kept)
- `/model [n]` — list models, or switch to the nth one
- `/del <n>` — delete (moves to trash, recoverable)
- `/trash` — inspect the trash; `/restore <n>` puts one back; `/purge` removes for good
- `/help` — everything

**Both directions**

- A plain message goes to the current session
- While a question or approval is pending, a plain message answers it
- Prefix with `//` to force a plain chat message

## Install

Two sides. **The DSH side is one command**:

```
dsh plugin --profile <your profile> add dsh-phone-bridge
```

`<your profile>` is usually `desktop`. **Restart DSH afterwards** - the client
half is scanned at startup and config hot-reload does not pick it up.

The package **ships its own bundle declaration** (`dsh.bundle.patch` pointing at
its bundled `cordis.patch.yml`), so `dsh plugin add` registers the host row into
your profile and the client half follows automatically. **No configuration file
has to be edited by hand.**

**The OpenClaw side** still needs its extension directory set up manually
(OpenClaw has its own extension mechanism). Full steps in
[docs/installation.md](docs/installation.md).

**For local development** you can skip npm and mount `dsh-plugin/` with a
`file://` URL instead, which lets you edit code without reinstalling. Pick one
of the two, not both.

## Configuration

**OpenClaw side** (the plugin's config block in `openclaw.json`):

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `allowedSenders` | `[]` | **allowed chat account ids**; empty means no restriction (dangerous) |
| `allowGroups` | `false` | respond in group chats |
| `bridgeUrl` | `http://127.0.0.1:19387/phone-bridge` | DSH side address |
| `notifyUrl` | `http://127.0.0.1:19387/dsh-notify` | question / approval endpoint |
| `pageSize` | `15` | entries per `/list` page |
| `turnTimeoutMs` | `300000` | per-turn timeout |

**DSH side** (the `config` of that row in your profile's `cordis.patch.yml`):

| Field | Default | Meaning |
|---|---|---|
| `routePath` | `/phone-bridge` | route prefix |
| `timeoutMs` | `300000` | default per-turn timeout |
| `pollIntervalMs` | `1000` | polling interval |
| `maxBodyBytes` | `1048576` | request body limit |
| `trashDir` | empty | trash location; empty means `<dsh home>/deleted-sessions` |

## Security

**This plugin hands your machine to whoever is on the other end of the chat.**
Please:

1. **Always set `allowedSenders`** to your own account id. Leaving it empty means
   anyone who can message the bot can drive your sessions.
2. **The routes are loopback only.** Do not expose them to a network.
3. Chat credentials and the tokens in `openclaw.json` are not part of this
   repository; keep them to yourself.

## Known limitations

- **OpenClaw is a hard dependency.** Without it this approach does not apply.
- **Channels that do not expose a sender id**: some leave `event.senderId` empty
  and keep the identity in the surrounding context. The plugin tries several
  fields and **refuses the request** when none of them resolve.
- **It uses DSH internals** (slot names, `sessionController`, the directory
  layout under `~/.dsh`). A DSH upgrade can break it.
- **There is no install script.** Two configuration files still have to be
  edited by hand.

## Compatibility

Both halves depend on DSH and OpenClaw internals, which can change between
releases. When it stops working, check in this order:

1. **DSH side route not mounted** — look for `phone-bridge listening on /phone-bridge` in the DSH startup log
2. **`sessionController` changed** — its use is concentrated in `runTurn` and a few route handlers in `dsh-plugin`
3. **Directory layout under `~/.dsh` changed** — sessions live in `sessions/<encoded cwd>/<sessionId>/`, projection caches in `storages/session_projcache/sessions/`
4. **OpenClaw hook changed** — it uses `api.on("before_dispatch", ...)`, not `api.registerHook` (the latter never fires for this event)

## Maintenance

Maintained by the author in spare time. Issues and pull requests are welcome and
will get attention where possible, though response time is not guaranteed.
Feature requests and compatibility reports (breakage after a DSH or OpenClaw
upgrade) are both appreciated.

## License

MIT — see [LICENSE](LICENSE).
