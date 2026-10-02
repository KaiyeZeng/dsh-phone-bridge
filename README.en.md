# dsh-phone-bridge

**Pick up the DSH session you are already running on your desktop, from your phone.**

Most phone setups add a **new entry point** to DSH: the bot creates its own
session, so what you say on the phone lives in a different conversation from the
ones in the desktop sidebar. The two contexts never meet.

This project does the other thing. The list on your phone **is** the list of
sessions on your desktop. Pick one, what you say lands in that very session, and
opening it on the desktop continues the same context.

Concretely: you ask DSH on your desktop to look something up, and halfway through
you have to leave. Another setup hands you a brand new bot and everything you
said is gone, so you start over. Here you send `/list`, then `/use 3`, and carry
on from the subway. It remembers all of it, and back at your desk the session is
still that same thread.

**This shared context is the only real advantage this project has.** On install
convenience, interface, stability and community validation it is not better than
more mature options, and on several counts it is worse. The honest list is under
"Known limitations" below.

English | [中文](README.md)

---

## How this differs

| | Typical setup | This project |
|---|---|---|
| Whose session | created by the bot | **the real desktop session** |
| Can you choose a session on the phone | no | **yes** (list / switch / search) |
| Context shared with the desktop | two separate ones | **the same one** |
| Session management | only "new session" | list / switch / search / rename / delete / trash |
| Access control | varies | **allowlist** of chat account ids |

## Why the OpenClaw layer is not optional

This is the project's biggest barrier to entry, and it is worth saying exactly why
it cannot simply be removed.

**DSH's HTTP port listens on `127.0.0.1` only**, so a phone cannot reach it even on
the same WiFi (measured: this machine's LAN address is `172.21.61.86`, while the
port is bound to loopback). Any scheme for driving a local service from a phone
needs a relay on the computer that both the computer and the phone can reach. That
is what OpenClaw is doing here, and it brings the WeChat, Telegram and Yuanbao
channel plumbing along with it.

Dropping it therefore means one of two things: expose DSH's port to the LAN, which
widens the attack surface considerably (loopback-only routes are one of this
project's stated security properties), or write another relay plus a phone client.
This project reuses OpenClaw rather than building its own.

In other words the layer is not packaging. **It is the path the phone takes to
reach your computer.**

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
- `/recent [n]` — the last few messages you sent to this session, 3 by default
- `/kill` — stop the running turn (queued messages are kept)
- `/model [n]` — list models, or switch to the nth one
- `/health` — check whether each layer of the link is up
- `/del <n>` — delete (moves to trash, recoverable)
- `/trash` — inspect the trash; `/restore <n>` puts one back; `/purge` removes for good
- `/pending` — show a pending question or approval
- `/help` — everything

> `/stop` is not available: OpenClaw claims it before any plugin hook runs, and it
> only aborts OpenClaw's own reply, not the DSH turn. Use `/kill` to stop a DSH
> turn.

**Both directions**

- A plain message goes to the current session
- While a question or approval is pending, a plain message answers it
- Prefix with `//` to force a plain chat message
- A mistyped command gets a suggestion (`/lst` answers "did you mean /list?") instead
  of being forwarded to DSH as prose
- When the allowlist turns you away it **replies with your own identity ids**, so you
  can paste one into `allowedSenders` without going to read the log on the computer
- **If the previous task is still running, your next message is answered at once**
  with how long it has been running, instead of being queued into a silence that
  looks like a dead link. That message is not forwarded.

## Install

Two sides, **one command each**.

**DSH side:**

```
dsh plugin --profile <your profile> add dsh-phone-bridge
```

`<your profile>` is usually `desktop`. **Restart DSH afterwards** - the client
half is scanned at startup and config hot-reload does not pick it up.

**Upgrading needs a manual range bump.** `dsh plugin add` will not cross a minor
version, because for a 0.x package `^` only allows the same minor (`^0.2.4` means
`>=0.2.4 <0.3.0`), and the command answers `Already up to date`. See "以后怎么升级"
in [docs/installation.md](docs/installation.md).

The package **ships its own bundle declaration** (`dsh.bundle.patch` pointing at
its bundled `cordis.patch.yml`), so `dsh plugin add` registers the host row into
your profile and the client half follows automatically. **No configuration file
has to be edited by hand.**

**OpenClaw side:**

```
openclaw plugins install openclaw-dsh-bridge --force --accept-capabilities
```

Both flags are required; without either one the install fails. Then allow and
configure it in `openclaw.json` (see below). Full steps in
[docs/installation.md](docs/installation.md).

Before installing, check that `~/.openclaw/extensions/` holds no second copy of
this plugin. An old backup directory is loaded as a plugin too, and two copies
sharing one id will forward every message twice.

**For local development** you can skip npm on both sides: mount `dsh-plugin/`
with a `file://` URL, and copy `openclaw-plugin/` into the extension directory.
Do not run the installed and local copies at the same time.

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
- **`/kill` cancels cooperatively.** It interrupts the running turn, but a long
  command that ignores interrupts, a one-shot `sleep` for instance, has to finish
  on its own first. The acknowledgement comes back immediately; receiving it does
  not mean the work has stopped.
- **Messages sent while a task is running are not forwarded.** They are intercepted
  and answered with a notice instead of being queued, so you are never left staring
  at a silent window. The cost is that you have to send it again. To queue instead,
  stop the current task with `/kill` first.
- **`/stop` does not work, and neither do the obvious alternatives.** OpenClaw
  claims `/stop`, `/halt`, `/abort`, `/interrupt`, `/exit`, `/停止` and `/暂停`
  before any plugin hook runs, and its handler aborts OpenClaw's own reply rather
  than the DSH session. Use `/kill`.
- **A freshly published npm version takes a few minutes to resolve.** `npm view`
  may answer 404 in the meantime; that is not a failed publish.

## Compatibility

### What this has actually been run against

These are combinations that were verified by hand, not "theoretically supported":

| | Version |
|---|---|
| DSH desktop | `0.2.0-rc.2` (profile `desktop`) |
| OpenClaw | `2026.9.5` (ec9c1a1) |
| OS | Windows 11 Home (Chinese) |
| Channels verified | WeChat (`@tencent-weixin/openclaw-weixin` 2.4.8), Yuanbao (2.18.3) |
| Node | 24.x |

**First thing to do after a DSH upgrade** is run `verify.ps1`, or read
`GET /phone-bridge/health`. It lists which of the ten `sessionController` methods
the plugin calls are missing. When one is, the error names it instead of leaving you
to try routes until something 500s.

### When it stops working

Both halves depend on DSH and OpenClaw internals, which can change between
releases. Check in this order:

1. **DSH side route not mounted** — look for `phone-bridge listening on /phone-bridge` in the DSH startup log
2. **`sessionController` changed** — check `/phone-bridge/health` first; only `cancel`, `create`, `follow`, `inspect`, `list`, `modelCatalog`, `prompt`, `rename`, `search` and `selectModel` are used, all called from `dsh-plugin/index.js`
3. **Directory layout under `~/.dsh` changed** — sessions live in `sessions/<encoded cwd>/<sessionId>/`, projection caches in `storages/session_projcache/sessions/`
4. **OpenClaw hook changed** — it uses `api.on("before_dispatch", ...)`, not `api.registerHook` (the latter never fires for this event)

## Maintenance

Maintained by the author in spare time. Issues and pull requests are welcome and
will get attention where possible, though response time is not guaranteed.
Feature requests and compatibility reports (breakage after a DSH or OpenClaw
upgrade) are both appreciated.

## License

MIT — see [LICENSE](LICENSE).
