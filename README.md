# dsh-phone-bridge

**用手机接着你电脑上正在聊的那个 DSH 会话。**

不是给你一个新机器人，是让你在手机上**切进桌面上已有的会话**、看它说到哪了、接着往下说。

[English](README.en.md) | 中文

---

## 和别的 DSH 手机方案有什么不同

现有的方案大多是**给 DSH 加一个新的聊天入口**：机器人在某个工作目录里开自己的会话，你在手机上聊的和电脑侧边栏里那些会话是两回事，两边上下文不通。

这个项目做的是另一件事：**手机上列出的就是你桌面上那些会话**，可以切换、搜索、重命名、删除，说出去的话落进那个会话本身——电脑上再打开，接的是同一段上下文。

| | 常见方案 | 本项目 |
|---|---|---|
| 会话归属 | 机器人自己新建 | **桌面已有的真实会话** |
| 手机上能选会话吗 | 不能 | **能**（列出 / 切换 / 搜索） |
| 和电脑上下文 | 两套 | **同一段** |
| 会话管理 | 只有「新会话」 | 列表 / 切换 / 搜索 / 重命名 / 删除 / 回收站 |
| 权限门 | 各自实现 | **白名单**（只允许指定的聊天账号） |

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
- `/help` 全部命令

> `/stop` 用不了，它是 OpenClaw 自己的中断指令，在插件之前就被截走，而且只掐断 OpenClaw 的回复，不会停 DSH 里的任务。要停 DSH 的任务用 `/kill`。

**双向**

- 直接发消息 = 发给当前会话
- 有挂起的提问或审批时，普通消息当作答复
- 想强行当聊天发，用 `//` 开头

## 安装

分两边装，**各一行命令**。

**DSH 侧：**

```
dsh plugin --profile <你的 profile> add dsh-phone-bridge
```

`<你的 profile>` 通常是 `desktop`。装完**重启 DSH**——client 半边在启动时扫描，配置热重载对它无效。

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
- **没有安装脚本**。目前要手工改两处配置。

## 兼容性

两个半边都依赖 DSH 与 OpenClaw 的内部实现，版本升级可能失灵。失效时按这个顺序查：

1. **DSH 侧路由没挂上** → 看 DSH 启动日志里有没有 `phone-bridge listening on /phone-bridge`
2. **`sessionController` 变了** → `dsh-plugin` 里对它的调用集中在 `runTurn` 和几个路由里
3. **`~/.dsh` 下的目录布局变了** → 会话在 `sessions/<cwd 编码>/<sessionId>/`，投影缓存在 `storages/session_projcache/sessions/`
4. **OpenClaw 的钩子变了** → 用 `api.on("before_dispatch", ...)`，不是 `api.registerHook`（后者对这个事件不生效）

## 维护状态

本项目由作者在业余时间维护。欢迎提 issue 和 PR，会尽量响应，但无法保证响应时间。功能建议、兼容性问题（DSH 或 OpenClaw 升级导致失效）都欢迎提出。

## 许可

MIT，见 [LICENSE](LICENSE)。
