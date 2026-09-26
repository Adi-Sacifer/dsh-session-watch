# dsh-session-watch —— 别的会话到底卡住了没有？

一个只读的小工具，回答一个文件时间戳回答不了的问题：

> 另一个对话安静了十分钟——**它是干完了，还是卡住了？**

```
scripts/probe-sessions.mjs   看看有没有会话卡住      ~7 KB
scripts/peek-text.mjs        看看那个会话在说什么    ~5 KB
scripts/dump-types.mjs       宿主格式变了就重新校准   ~3 KB
```

纯 Node，**零依赖**。

**[English README](README.md)**

---

## 它解决什么问题

同时开着几个对话干活的时候，其中一个不动了。你只能看到"它不动了"——**但一个正常的、干完活的会话，和一个挂死的会话，在文件时间戳上长得一模一样**。

这两件事的差别是**要命**的：

| | 干完了 | 卡住了 |
|---|---|---|
| 你该做什么 | 去看它的产出 | 去救它 |
| 再等下去 | 白等 | 一直白等 |

这个工具用**转录自己的形状**把两者分开。

## 判据：健康的回合是有形状的

不是猜的，是把真实转录解出来数的。一个健康回合长这样：

```
turn/start → step/start → assistant/message → tool/call → tool/result → turn/end
                                                              ↑ 收在 turn/end 才算走完
```

于是一条规则就够了：

| 转录尾部状态 | 转录还在长吗 | 判定 |
|---|---|---|
| 结尾是 `turn/end` | — | **正常闲置**，它干完了 |
| 有没配对的 `tool/call` | 还在长 | **正在干活** |
| 有没配对的 `tool/call` | **停笔超过阈值** | **卡住了** ⚠️ |

## 用法

```powershell
node scripts/probe-sessions.mjs                 # 默认：90 分钟内活跃的会话
node scripts/probe-sessions.mjs --minutes 240 --stale 300
```

Windows 上双击就行：`check-sessions.cmd`

真实输出（实测）：

```
=== cross-session stuck check   22:08:38
    window: touched within 120 min   |   sessions on disk: 25
    rule: silent > 180s with an unmatched tool/call  =>  stuck

-- working -------------------------------------
* session-dbeaf1b0-...   检查会话卡住功能询问
    340.2 KB · last write 22:08:38 · quiet 0s · record tool/call
    tail: open tool/call (pwsh)

-- idle (turn closed cleanly) ------------------
    session-281088bf-...   quiet   520s  AI恋人框架与酒馆结合可行性

>>> all clear: no session is parked on an unmatched tool call.
    Checked 5 session(s) touched in the last 120 min.
```

看别的会话**在说什么**（它自己的进展汇报）：

```powershell
node scripts/peek-text.mjs session-551a5c44 3 --chars 800
# 目标可以写完整 id、id 片段、或者标题片段
```

```
--- assistant 22:06:18 ---
`setContextLimit` exists — the page had a stale bundle at that moment.
Let me now fix the script's remaining real bugs: the 8-vs-9 message mismatch and the leaking selectors.

tool calls=147  unresolved=0
```

## 两个会毁掉结论的假信号（都是真踩过的）

这部分比脚本本身值钱。**假警报比不报更糟**——它会让你去救一个根本没事的会话。

### 假信号 1：用"有没有对应进程"判断会话死活

第一版这么写的，结果**把一个完全健康的会话标成卡住**。原因：DSH 宿主进程的命令行里**不带会话 id**，所以"找不到对应进程"是纯噪声。

改成看**转录自己停没停**才是对的。

### 假信号 2：用 `data.callId` 配对工具调用和结果

**工具结果的 id 不在 `data.callId` 上**，它在：

```js
tool/call    →  data.callId
tool/result  →  data.message.toolCallId     // ← 注意这层嵌套
```

用错字段的后果：一个**干得好好的**会话，145 个工具调用**全部**被报成"未闭合"。

```
用错字段： tool calls=145  unresolved=145   ← 全挂着？不可能，这是假警报
用对字段： tool calls=145  unresolved=0     ← 真相
```

**如果当时没发现这个 bug，结论会从"它很健康"变成"它 145 个调用全挂死了"——正好说反。**

## 转录文件到底是什么格式

想自己读这些文件的话，这段能省你一个下午。

```
~/.dsh/sessions/<工作区>/<会话-id>/session.v4.jsonl.zstd   转录正文
~/.dsh/storages/session_projcache/sessions/<会话-id>.json   标题、用量
```

**那个 `.zstd` 不是一条压缩流。** 它是追加写入的日志，大约 **1500 个彼此独立的 zstd 帧**，每 flush 一次一帧。所以：

```js
zstdDecompressSync(buf)          // ❌ 只吃第一帧，吐出来一点点
createZstdDecompress()           // ❌ 一样只吃第一帧
```

它们只会给你**第一帧**——看起来就像"这个会话是空的"，然后你就会去一个完全错误的方向找 bug。

真正的读法是扫帧魔数 `28 B5 2F FD`，按边界逐帧解压再拼接。实测一个真实的会话：**5184 帧、解出 8104 条记录、0 失败**。帧体理论上可能凑巧包含这几个字节，所以解不出来的帧要**向后合并**直到能解开。会话正在进行时，末尾出现**半个帧是正常的**，跳过即可。

记录是 JSONL。值得知道的几种：

| 记录 | 文本在哪 |
|---|---|
| `user/message` | `data.content[]` 里 `type === "text"` 的项；`data.source.kind` 区分人说的（`user`）和宿主注入的样板（`runtime-context` 等） |
| `assistant/message` | `data.message.content[]` 里 `type === "text"` 的项 —— **思考块和可见文本在同一个数组里**，必须按 `type` 过滤 |
| `tool/call` | `data.name` + `data.arguments`（JSON 字符串） |
| `tool/result` | `data.message.toolCallId`（配 `tool/call` 的 `data.callId`） |

宿主改了格式的话，`scripts/dump-types.mjs` 五秒内告诉你：

```powershell
node scripts/dump-types.mjs <会话文件>
```

它会打印记录类型直方图、尾部 12 条类型顺序、以及**配对规则依赖的两个字段到底在不在**。

## 作用域与隐私 —— 这条最重要

本仓库和 [`dsh-session-recall`](https://github.com/Adi-Sacifer/dsh-session-recall) 是配套的，但**读的东西不一样**：

| | 读什么 | 需要用户开口吗 |
|---|---|---|
| `probe-sessions` | 会话的**元数据**：大小、时间戳、尾部记录类型 | 不需要——它不读内容 |
| `peek-text` | 别的会话的**助手回复正文** | **需要。** 必须用户明确要求 |

`peek-text` 读的是别人的对话内容，所以和 session-recall 遵守**同一条规则**：**默认只读当前对话，跨对话读取只在用户当轮明确要求时才做。** 别为了"获取上下文"去翻用户别的聊天——这正是这类工具设计上**不该变成**的样子。

一个已经踩过的教训：为了"自动巡检"，宿主（Agent）在没人请求的情况下去读别的会话——**这正是这条规则要防的**。所以 `probe-sessions` 刻意做成只碰元数据。

## 已知盲区（不瞒你）

1. **纯模型流式挂住抓不到。** 如果某个会话是模型请求挂住（TCP 连着、字节不来），它的转录会表现为"回合开着、没有工具调用"——当前会算进"正在干活"。要抓这种得看那个会话的 SSE 空闲超时。
2. **只对磁盘上还在的会话有效。** 会话被删掉就没了。
3. **正在进行的会话最后半个帧可能还没 flush**，所以可能差一两条记录。这不影响判据（判据看的是尾部状态，不是消息数）。
4. **它是只读快照，不是守护进程。** 它不会"过一会儿自己看一眼"——没有常驻循环。你要看的时候跑一次。做常驻要装插件（见下）。

## 为什么不做成常驻自动巡检

问过，也明确选了**不做**。原因是诚实的：

一个会话里跑着的 Agent **无法给自己排闹钟**。它一轮说完就停了，没有"过一会儿自己醒过来"的机制。真正能定时的是**宿主插件**（定时器 + 会话事件），那是个大得多的东西，而且有自己的风险——**自动读别的会话内容**正好撞上上面那条隐私规则。

所以这里选择：**工具只在你问的时候看，不做后台自动读。**

## 环境要求

**Node 22+。** 就这一条——`zlib` 自带 zstd，所以零依赖，不用装任何东西，不用编译。

`check-sessions.cmd` 会先找 PATH 里的 `node`，找不到就回退到 Windows 上 DSH 内置的运行时。

## 授权

MIT，见 [LICENSE](LICENSE)。
