# openclaw-dsh-wechat-bridge

Drive an existing **DeepSeek Harness desktop** session from WeChat, Telegram or
Yuanbao. Messages you send from the phone land in the desktop session you pick,
and its reply comes back to the chat.

> **This is the OpenClaw half.** It needs the DSH half installed too, otherwise it
> has nothing to talk to:
>
> ```powershell
> dsh plugin --profile desktop add dsh-wechat-bridge
> ```
>
> Both halves live in <https://github.com/KaiyeZeng/dsh-wechat-bridge>.

## Install

```powershell
openclaw plugins install openclaw-dsh-wechat-bridge
```

Then set your own sender id in the plugin config before anyone else can reach it.

## Lock it down first

**This plugin lets whoever can message your bot run commands on your computer.** The
DSH side runs with approvals disabled on purpose, because a phone cannot answer a
desktop approval dialog.

Set `allowedSenders` to your own chat account id and leave it non-empty:

```json
{
  "plugins": {
    "entries": {
      "dsh-bridge": {
        "enabled": true,
        "config": {
          "allowedSenders": ["your-id-here"],
          "allowGroups": false
        }
      }
    }
  }
}
```

An empty `allowedSenders` means **everyone** is allowed. Do not run it that way.

The plugin logs every inbound message and every blocked sender to
`%LOCALAPPDATA%\dsh-bridge\hook.log`, so you can read the real id off a blocked
attempt rather than guessing it.

## Commands

Send these to the bot. One per line, because a chat bubble is not a terminal.

| Command | Does |
|---|---|
| `/list [页]` | list desktop sessions |
| `/use <序号>` | pick which session your messages go to |
| `/where` | show the current session, its directory, last activity |
| `/find <词>` | find a session by title |
| `/find-any <词>` | search message bodies |
| `/new [标题]` | create a session and switch to it |
| `/name <标题>` | rename the current session |
| `/status` | current session state |
| `/kill` | cancel the session's running turn |
| `/model [序号]` | list models, or switch to one |
| `/del <序号>` | delete a session (recoverable) |
| `/trash` | inspect the trash |
| `/restore <序号>` | put a trashed session back |
| `/purge [序号]` | erase trashed data for good |
| `/pending` | show a pending question or approval |
| `/help` | the whole list |

A plain message goes to the current session. While a question or approval is
pending, a plain message is treated as the answer, so prefix `//` to force it
through as chat instead.

## Why `/kill` and not `/stop`

OpenClaw claims `/stop` before any plugin hook runs. Its abort set matches `/stop`
plus the bare words `stop`, `halt`, `abort`, `interrupt`, `exit`, `停止`, `暂停` and
about forty more, and it aborts OpenClaw's own reply rather than the DSH session.
Use `/kill` to stop a DSH turn; `/stop` will appear to work while the desktop keeps
running.

MIT licensed.
