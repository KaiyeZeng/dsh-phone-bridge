# 更新记录

两个包各自独立发版，版本号不一定对应。按 npm 上的版本号倒序记录，对应到仓库里的提交。

## openclaw-dsh-bridge

### 0.2.2
- 去掉 `openclaw.plugin.json` 里的 UTF-8 BOM。OpenClaw 加载时容忍它，但 `openclaw plugins validate` 会把清单判成坏 JSON，装完跑 doctor 会看到一个莫名其妙的报错
- 对应提交：本版之前的内容见 `3b2ef0a`

### 0.2.1
- 这一版有问题，别用：修 BOM 时被 PowerShell 又写回一个 BOM 进去
- 首次给包内带上 README 和 LICENSE

### 0.2.0
- 首次发布到 npm，从此可以 `openclaw plugins install openclaw-dsh-bridge --force --accept-capabilities` 一行装，不用再手工拷扩展目录
- `/stop` 改名 `/kill`。OpenClaw 自己占用了 `/stop`（以及 `halt`、`abort`、`interrupt`、`exit`、`停止`、`暂停` 等约四十个词），它在插件之前就把消息截走，而且停的是 OpenClaw 的回复而不是 DSH 的任务，手机会显示已停下而电脑还在跑
- `/kill` 改成发出请求立刻回执，不再等 DSH 的往返。等待会让这个指令在最需要它的场景里失效——任务跑着的时候发它，要等任务结束才有回应
- `/help` 去掉等宽对齐，改成一条命令一行。对齐在终端里好看，在聊天框里因为字体不等宽和自动换行会散架
- 新增 `/status`（当前会话状态、工作目录、活跃时间）、`/model [序号]`（查看或切换模型）

### 0.1.0
- 没有发布到 npm，靠手工拷贝到 `~/.openclaw/extensions/` 使用

## dsh-phone-bridge

### 0.2.2
- 包内 README 补上 OpenClaw 那半的安装命令和那两个必需参数，以及「扩展目录里不能有第二份副本」的提醒
- 这一版由 GitHub Actions 自动发布，是发布流程的首次实测

### 0.2.1
- 包内补上 README 和 LICENSE。`files` 里列了这两个文件但目录里不存在，npm 不报错、直接跳过，所以 0.1.0 的包里没有它们

### 0.2.0
- `/sessions` 改为按 DSH 的工作区登记过滤，手机端列表与桌面侧边栏一致。侧边栏渲染的是 `~/.dsh/storages/workspace.json` 的登记而不是磁盘，而手机端原来读磁盘，于是把从未登记过的会话（子代理会话、登记机制出现前建的）也列了出来，看起来像「删了还在」。本机实测登记 9 个、磁盘 17 个
- `/sessions` 与 `/status` 只返回会话标题，不再发整包会话投影。那包里含 token 统计、上下文压力、逐轮大纲，15 行就要 49 KB，删减后降到 1 KB 量级
- 新增路由 `/status`、`/stop`、`/models`、`/model`，对应手机端的 `/status`、`/kill`、`/model`
- 新增 `/restore` 对应的恢复能力：`/trash` 返回 `restorable` 字段，没有原位置记录的条目会被标出来而不是猜一个位置

### 0.1.0
- 首次发布。手机桥（会话列表、搜索、新建、重命名、投递消息）+ 桌面侧边栏的删除按钮和回收站面板，合并成一个 dual-face 包
- 删除是移动而不是删除文件，落在 `~/.dsh/deleted-sessions/`，所以可恢复

## 关于 `0.0.0-stage`

npm 上还有一个 `dsh-phone-bridge@0.0.0-stage`，是早期用 stage-only token 的发布权限时自动生成的占位包（`Temporary package placeholder for staged publishing`），没有任何实际内容，可以忽略。
