# dsh-phone-bridge

**用手机接着你电脑上正在聊的那个 DSH 会话。**

手机上的方案大多是在给 DSH 加一个新入口：机器人自己开一个会话，你在手机上聊的和电脑侧边栏里那些是两个东西，上下文不通。

这个项目做的是另一件事。**手机上 `/list` 列出来的就是你桌面上那些会话**，选一个，你说的话落进那个会话本身，回到电脑上打开接的是同一段上下文。

具体一点。你在电脑上让 DSH 查个东西，聊到一半要出门。别的方案会给你一个全新机器人，前面聊的全部丢失，你得重新交代一遍。这个方案你在地铁上 `/list`、`/use 3`，接着问，它记得前面所有内容；回家打开电脑，还是那条线，历史都在。

**这是本项目唯一的差异化优势。** 其他方面（安装便利、界面、稳定性、社区验证）它并不比成熟方案强，有几项还更弱，都写在「已知限制」里。

[English](README.en.md) | 中文

---

## 和别的方案的区别

| | 常见方案 | 本项目 |
|---|---|---|
| 会话归属 | 机器人自己新建 | **桌面已有的真实会话** |
| 手机上能选会话吗 | 不能 | **能**（列出 / 切换 / 搜索） |
| 和电脑的上下文 | 两套 | **同一段** |
| 会话管理 | 只有「新会话」 | 列表 / 切换 / 搜索 / 重命名 / 删除 / 回收站 |
| 权限门 | 各自实现 | **白名单**（只允许指定的聊天账号） |

## 为什么要多装一层 OpenClaw

这是本项目最大的使用门槛，值得说清楚它为什么绕不开。

**DSH 的 HTTP 端口只监听 `127.0.0.1`**，手机即使连在同一个 WiFi 下也够不到它（实测本机局域网地址是 `172.21.61.86`，而端口只绑回环）。任何「用手机操作电脑上本机服务」的方案，都必须在电脑上跑一个**本机够得到、手机也够得到**的中转。OpenClaw 就是在做这件事，顺带把微信、元宝这些渠道接好。

所以去掉这一层的代价是明确的两选一：要么把 DSH 的端口暴露到局域网，攻击面直接变大（而「所有路由只绑回环」正是这个方案的安全优点之一）；要么自己再写一个中转加一个手机端。本项目选择复用 OpenClaw，而不是自己造。

换句话说，这一层不是多余的包装，**它就是手机能到达电脑的那条路**。

## 组成

两个插件，一个仓库，**都要装**：

```
手机聊天软件 ──► OpenClaw ──► openclaw-plugin ──HTTP──► dsh-plugin ──► 桌面会话
                    │                                        │
                    └──────────── 提问 / 审批 ─────────────────┘
```

| 目录 | 装在哪 | 职责 |
|---|---|---|
| [`openclaw-plugin/`](openclaw-plugin/) | OpenClaw | 拦截聊天消息，翻译成 HTTP 调用；把挂起的提问和审批带回聊天窗口 |
| [`dsh-plugin/`](dsh-plugin/) | DSH 桌面版 | 在回环地址上暴露一组路由，操作真实的 `sessionController` |

**为什么必须有 DSH 里那一半**：`dsh --profile headless` 会拒绝任何带 agent preset 的会话（源码里写死的 `if (preset !== void 0) throw`），所以从进程外面驱动桌面会话这条路走不通。跑在桌面进程内部，`sessionController` 就在手边。

## 功能

**手机侧**

- `/list [页]` 列出桌面会话
- `/use <序号>` 切换到某个会话
- `/where` 看当前接的是哪个
- `/find <词>` 按标题找；`/find-any <词>` 连正文一起找
- `/new` 新建会话
- `/name <标题>` 重命名
- `/status` 看当前会话状态、工作目录、活跃时间
- `/kill` 停下正在跑的任务（排队的消息保留）
- `/model [序号]` 查看可用模型，带序号就是切换
- `/del <序号>` 删除（移进回收站，可恢复）
- `/trash` 看回收站；`/restore <序号>` 放回原位置；`/purge` 彻底清除
- `/pending` 看挂起的提问或审批
- `/help` 全部命令

> `/stop` 用不了，它是 OpenClaw 自己的中断指令，在插件之前就被截走，而且只掐断 OpenClaw 的回复，不会停 DSH 里的任务。要停 DSH 的任务用 `/kill`。

**双向**

- 直接发消息 = 发给当前会话
- 有挂起的提问或审批时，普通消息当作答复
- 想强行当聊天发，用 `//` 开头
- 指令打错时会给建议（`/lst` → 「是想用 /list 吗」），而不是把这条错指令原样丢给 DSH
- 被白名单拦下时，会**把你的身份 ID 回给你**，你直接复制进 `allowedSenders` 就行，不用去翻电脑上的日志

## 安装

分两边装，**各一行命令**。

**DSH 侧：**

```
dsh plugin --profile <你的 profile> add dsh-phone-bridge
```

`<你的 profile>` 通常是 `desktop`。装完**重启 DSH**——client 半边在启动时扫描，配置热重载对它无效。

**升级要手动改范围**：`dsh plugin add` 不会跨小版本升级，因为 0.x 版本的 `^` 只允许同一个次版本（`^0.2.4` 等于 `>=0.2.4 <0.3.0`），它会回你一句 `Already up to date`。步骤见 [docs/installation.md](docs/installation.md) 的「以后怎么升级」。

这个包**自带 bundle 声明**（`dsh.bundle.patch` 指向包内的 `cordis.patch.yml`），所以 `dsh plugin add` 会把 host 半边的条目注册进 profile，client 半边会跟着自动挂上，**不需要手工编辑任何配置文件**。

**OpenClaw 侧：**

```
openclaw plugins install openclaw-dsh-bridge --force --accept-capabilities
```

两个参数都得带，缺一个装不上。装完在 `openclaw.json` 里放行并配置（见下一节）。完整步骤见 [docs/installation.md](docs/installation.md)。

装之前确认 `~/.openclaw/extensions/` 里没有这个插件的第二份副本——旧备份目录也会被当成插件加载，两份同时跑会把同一条消息转发两次。

**本地开发时**也可以不走 npm：DSH 侧用 `file://` 把 `dsh-plugin/` 挂进 profile，OpenClaw 侧把 `openclaw-plugin/` 复制进扩展目录，改完代码不用重装。两边都别同时用安装版和本地版。

## 配置

**OpenClaw 侧**（`openclaw.json` 里这个插件的配置段）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `allowedSenders` | `[]` | **允许的聊天账号 ID**。空 = 不限制（危险） |
| `allowGroups` | `false` | 是否响应群聊 |
| `bridgeUrl` | `http://127.0.0.1:19387/phone-bridge` | DSH 侧地址 |
| `notifyUrl` | `http://127.0.0.1:19387/dsh-notify` | 提问/审批接口 |
| `pageSize` | `15` | `/list` 每页条数 |
| `turnTimeoutMs` | `300000` | 单轮超时 |

**DSH 侧**（profile 的 `cordis.patch.yml` 里那一行的 `config`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `routePath` | `/phone-bridge` | 路由前缀 |
| `timeoutMs` | `300000` | 单轮默认超时 |
| `pollIntervalMs` | `1000` | 轮询间隔 |
| `maxBodyBytes` | `1048576` | 请求体上限 |
| `trashDir` | 空 | 回收站位置；空 = `<dsh 家目录>/deleted-sessions` |

**这个插件没有任何 npm 依赖**，只用 Node 内置模块。这是刻意的：用 `file://` 从磁盘直挂时没有 `node_modules`，一旦 import 了第三方包（比如 `@deepseek-ai/schemastery`），加载会失败，**而且失败时整条手机链路一起失效**。所以配置不走 schema 校验，而是直接取 `apply()` 的第二个参数，留空就用上面的默认值。

## 安全

**这个插件能把你的电脑交给聊天窗口那一端。** 请务必：

1. **一定要设 `allowedSenders`**，只填你自己的账号 ID。留空等于任何能给机器人发消息的人都能驱动你的会话。
2. **路由只监听回环地址**。不要把它映射到公网。
3. 聊天账号的凭据、`openclaw.json` 里的 token，都不属于本仓库，自己保管。

## 已知限制

- **依赖 OpenClaw**。不想装 OpenClaw 的话这个方案用不了。
- **微信渠道拿不到发送者 ID 的情况**：某些渠道的 `event.senderId` 是空的，身份要从上下文里取。插件会尝试多个字段，一个都取不到时**拒绝请求**（宁可不响应）。
- **走的是 DSH 内部接口**（插槽、`sessionController`、`~/.dsh` 下的目录布局）。DSH 升级可能失效，见下面的兼容性说明。
- **`/kill` 是协作式取消**。它会中断正在进行的对话轮次，但如果当前跑的是一条不响应中断的长命令（比如一次性的 `sleep`），要等它自己结束才真正停下。回执是立刻返回的，**收到回执不等于任务已经停了**。
- **`/stop` 用不了**，别试。它是 OpenClaw 自己的中断指令，在插件之前就被截走，而且只掐断 OpenClaw 的回复，不会停 DSH 里的任务。同理 `/halt`、`/abort`、`/interrupt`、`/exit`、`/停止`、`/暂停` 也都被它占用。
- **npm 刚发布的版本要几分钟才可查**。这期间 `npm view` 可能报 404，不是发布失败。

## 兼容性

### 实测环境

下面这些是**实际跑通的组合，不是「理论上支持」**：

| | 版本 |
|---|---|
| DSH 桌面版 | `0.2.0-rc.2`（profile `desktop`） |
| OpenClaw | `2026.9.5` (ec9c1a1) |
| 操作系统 | Windows 11 家庭版（中文） |
| 已验证渠道 | 微信（`@tencent-weixin/openclaw-weixin` 2.4.8）、元宝（2.18.3） |
| 已验证 Node | 24.x |

**升级 DSH 之后第一件事**：跑 `verify.ps1`，或者直接看 `GET /phone-bridge/health`。它会列出插件用到的 10 个 `sessionController` 方法里有没有缺失的。缺了就是 DSH 改了内部接口，那时的报错会直接点名是哪个方法，不用逐个路由试。

### 失效时的排查顺序

两个半边都依赖 DSH 与 OpenClaw 的内部实现，版本升级可能失灵。按这个顺序查：

1. **DSH 侧路由没挂上** → 看 DSH 启动日志里有没有 `phone-bridge listening on /phone-bridge`
2. **`sessionController` 变了** → 先看 `/phone-bridge/health` 报缺哪个；用到的方法只有 `cancel`、`create`、`follow`、`inspect`、`list`、`modelCatalog`、`prompt`、`rename`、`search`、`selectModel` 这几个，调用全在 `dsh-plugin/index.js` 里
3. **`~/.dsh` 下的目录布局变了** → 会话在 `sessions/<cwd 编码>/<sessionId>/`，投影缓存在 `storages/session_projcache/sessions/`
4. **OpenClaw 的钩子变了** → 用 `api.on("before_dispatch", ...)`，不是 `api.registerHook`（后者对这个事件不生效）

## 维护状态

本项目由作者在业余时间维护。欢迎提 issue 和 PR，会尽量响应，但无法保证响应时间。功能建议、兼容性问题（DSH 或 OpenClaw 升级导致失效）都欢迎提出。

## 许可

MIT，见 [LICENSE](LICENSE)。
