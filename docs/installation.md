# 安装

两边都要装。**顺序无所谓，但都装完之前不会有任何反应**，而且装错了**不会报错**——这一点在最后面「怎么知道装对了」里单独说。

---

## 一、DSH 侧

### 1. 放文件

把 `dsh-plugin/` 这个目录复制到一个不会被 DSH 升级覆盖的地方，比如：

```
<你的目录>/dsh-plugin/
```

不要放进 DSH 的安装目录（升级会被清掉）。

### 2. 挂进 profile

打开你的 profile 配置文件：

```
<DSH 配置根>/profiles/<profile 名>/cordis.patch.yml
```

`<DSH 配置根>` 默认是 `~/.dsh`，`<profile 名>` 通常是 `desktop`。

在文件末尾加一段：

```yaml
- insert:
    - id: dsh-phone-bridge
      name: "file:///<上面那个目录的绝对路径>/dsh-plugin/index.js"
      config:
        routePath: /phone-bridge
```

**三个容易踩的地方**：

1. **`file://` 后面必须是绝对路径**，而且**不能写 `~`**——它不会展开。Windows 上写成 `file:///C:/path/to/dsh-plugin/index.js`（三个斜杠，路径里的反斜杠换成正斜杠）。
2. **指向 `index.js` 这个文件**，不是目录。
3. **必须放在 `- insert:` 下面**。`cordis.patch.yml` 里裸写的 `- id:` 是**覆盖已有行**，不是新增；只有 `insert` 段里的才是新条目。放错地方不会报错，只会悄无声息地不生效。

### 3. 重启 DSH

配置热重载对**新增插件**不生效（对已有插件的配置改动才生效）。**必须完整重启 DSH。**

---

## 二、OpenClaw 侧

### 1. 放文件

把 `openclaw-plugin/` 复制到 OpenClaw 的扩展目录：

```
~/.openclaw/extensions/dsh-bridge/
```

（目录名不一定要叫 `dsh-bridge`，但下面配置里的路径要和它一致。）

### 2. 放行插件

OpenClaw 的插件是**白名单制**。编辑 `~/.openclaw/openclaw.json`，在 `plugins.allow` 里加上这个插件的名字：

```json
{
  "plugins": {
    "allow": [
      "dsh-bridge"
    ]
  }
}
```

名字要和扩展目录里的 `package.json` 的 `name` 对得上，或者和你给这个扩展起的 id 一致。**不加白名单，插件不会被加载，也不报错。**

### 3. 配置

同一个 `openclaw.json` 里，给这个插件写配置：

```json
{
  "plugins": {
    "config": {
      "dsh-bridge": {
        "enabled": true,
        "allowedSenders": ["<你的聊天账号 ID>"],
        "allowGroups": false
      }
    }
  }
}
```

**`allowedSenders` 一定要填。** 留空等于任何能给这个机器人发消息的人都能驱动你的电脑。

**怎么拿到自己的 ID**：先**留空**跑一次，随便发条消息，然后看日志：

```
%LOCALAPPDATA%\dsh-bridge\hook.log        (Windows)
```

里面会有一行 `fire channel=... isGroup=... chars=... id=<候选1>|<候选2>`。把 `id=` 后面那串填进 `allowedSenders`，**然后重启**。

> **为什么会有多个候选**：不同渠道把发送者身份放在不同字段里。微信公众号渠道的 `event.senderId` 是空的，身份在上下文里。插件会试多个字段，**一个都取不到时直接拒绝**（宁可不响应，也不放开）。

### 4. 重启 Gateway

OpenClaw 的 `plugins reload` **不会重新加载代码**，改了插件要重启 Gateway：

```powershell
Restart-Service <OpenClaw Gateway 的服务名>
```

或者用 OpenClaw 自己的管理命令。

---

## 三、怎么知道装对了

**这一步别跳过。** 这个链路的失败方式几乎都是**静默的**：不报错、没反应，你会以为是聊天软件的问题。

**检查 1：DSH 侧路由挂上了吗**

DSH 启动日志里应该有：

```
phone-bridge listening on /phone-bridge
```

没有这行 = 插件没加载。回头检查 `cordis.patch.yml` 的 `insert` 缩进和 `file://` 路径。

也可以直接打一下：

```powershell
curl.exe -s http://127.0.0.1:19387/phone-bridge/sessions
```

返回 `{"sessions":[...]}` = 通了。返回 404 = 没挂上。

**检查 2：OpenClaw 侧收到消息了吗**

发一条消息给你的机器人，然后看：

```
%LOCALAPPDATA%\dsh-bridge\hook.log
```

- **文件根本没生成** → 插件没被加载（白名单没加？）
- **有 `fire ...` 行但没有后续** → 消息收到了，但被白名单拦了（`blocked ids=...`）或者转发失败
- **有 `blocked ids=`** → 你的 `allowedSenders` 和实际 ID 对不上

**检查 3：端到端**

在聊天窗口发 `/help`。**能收到命令列表 = 全通了。**

---

## 四、踩过的坑

这些是开发过程中真实踩到的，按遇到概率排序。

**1. `api.registerHook` 对 `before_dispatch` 永远不触发**

必须用 `api.on("before_dispatch", ...)`。用错了不报错，只是什么都不发生。

**2. 消息正文是 `event.content`，不是 `event.text`**

读错字段拿到空字符串，插件会当成空消息直接返回。

**3. `openclaw agent -m` 绕过钩子**

用命令行发消息测试时钩子不触发，必须从**真正的聊天窗口**发。

**4. `openclaw plugins reload` 不重载代码**

只重载配置。改代码要重启 Gateway。

**5. `openclaw doctor --fix` 会禁用 Gateway 的定时任务**

跑完它之后 Gateway 可能就不开机自启了。检查：

```powershell
Get-ScheduledTask -TaskName "*OpenClaw*" | Select-Object TaskName, State
```

被禁用了就 `Enable-ScheduledTask` + `Start-ScheduledTask`。

**6. Gateway 启动很慢（47-99 秒），`openclaw status` 经常误报**

端口已经通了、渠道已经能用了，`status` 还可能显示 `unreachable (timeout)`。**不要因此反复重启**，等它。

**7. 会话列表里有「幽灵行」**

删掉会话之后，侧边栏里还在、还能点开（但读不到内容），重启也不消失。

原因：DSH 的侧边栏渲染的是 `~/.dsh/storages/workspace.json` 里记录的工作区归属，**不扫描磁盘**。只把文件移走的话，登记还在。

修法：`dsh-plugin` 在删除和恢复时会分别调 `archiveSession` / `unarchiveSession` 同步这份登记。如果你自己改了删除逻辑，**别漏掉这一步**。

**8. 会话文件不是纯文本**

`~/.dsh/sessions/<cwd 编码>/<sessionId>/session.v4.jsonl.zstd` 是 **zstd 压缩**的，用 `grep` 搜不到内容。要找某段对话，用 DSH 自己的搜索。

---

## 五、卸载

**DSH 侧**：把 `cordis.patch.yml` 里那段删掉，重启 DSH。

**OpenClaw 侧**：从 `plugins.allow` 里去掉名字，删掉扩展目录，重启 Gateway。

**回收站里的东西**：在 `<DSH 配置根>/deleted-sessions/` 下，删之前先确认里面没有你还想要的会话。
