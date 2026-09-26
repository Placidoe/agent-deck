# 多 Agent 上下文与 Token 架构

## 结论

多开会话的风险是真实的：如果每个 Agent 都拿到完整需求、完整主会话、全部子会话消息和全部工具输出，输入 Token 会随 Agent 数和通信边数迅速膨胀；更糟的是，冗余历史会稀释当前任务的关键信号。产品不应把“共享上下文”实现成共享聊天记录。

Agent Deck 应把上下文当作一种**可寻址、可验证、按需装配的本地资源**。每个 Agent 保持自己的连续工作会话；跨 Agent 只共享经过结构化提炼的事实、决定、产物和可回溯证据。主 Agent 是编排器与审稿人，不是所有消息的转发器。

目标不是追求最小 Token 数，而是在固定预算内最大化“任务相关、带来源、可执行”的 Token 密度。

## 两个问题，两个不同解法

| 问题 | 天真的实现 | 后果 | Agent Deck 的解法 |
|---|---|---|---|
| 单个会话的连贯性 | 截断或把整段历史反复塞回去 | 遗忘、语义漂移、输入越来越长 | 工作上下文 + 任务检查点 + 可检索证据三层记忆 |
| 多会话协作 | 广播聊天记录、全员互评 | 重复输入、消息风暴、角色互相干扰 | 共享状态图 + 引用式消息 + 定向路由 |
| 结果可信度 | 摘要替代原始证据 | 数字、路径、决定在压缩时丢失 | 摘要必须携带 `evidence_ref`，可一键回到原始日志、文件、diff 或网页 |
| 复杂需求拆解 | 一开始启动很多 Agent | 还没收敛问题就烧掉 Token | 主 Agent 先计划；仅对依赖图中可并行、预期收益为正的任务派发 |

## 论文证据：可以借鉴什么

| 论文 / 会议 | 关键发现 | 对 Agent Deck 的具体启发 | 成熟度 |
|---|---|---|---|
| [LLMLingua](https://aclanthology.org/2023.emnlp-main.825.pdf), EMNLP 2023 | 通过分层预算控制和 token 级压缩减少提示词冗余；论文报告高压缩比下仍可保持任务能力。 | 对“要注入给 Agent 的长背景”做预算化压缩，但不压缩文件路径、命令、数字、验收条件。 | 可直接采用 |
| [LongLLMLingua](https://arxiv.org/abs/2310.06839), 2023 | 长上下文中，压缩和重排关键证据可同时改善表现与成本；报告在 NaturalQuestions 上约 4 倍更少 Token。 | 检索结果按“当前子任务相关性 + 证据等级 + 新鲜度”重排，最关键的项目放在上下文前后。 | 可直接采用 |
| [MemGPT](https://arxiv.org/abs/2310.08560), 2023 | 将上下文窗口视为有限 RAM，将外部存储视为可分页的持久内存。 | 建立本地 Context Kernel：当前工作集永远小，完整历史与证据按引用保存在 SQLite / 文件系统。 | 架构原则 |
| [HiAgent](https://aclanthology.org/2025.acl-long.1575/), ACL 2025 | 用子目标作为工作记忆块，仅保留当前子目标相关的动作—观察；论文在五个长程任务上报告成功率提升、平均步数减少。 | 每个任务完成或切换阶段时生成“任务检查点”，而不是给下游 Agent 粘贴完整对话。 | 可直接采用 |
| [Context as a Tool](https://aclanthology.org/2026.findings-acl.1032/), Findings of ACL 2026 | 将上下文维护提升为 Agent 可调用工具，区分稳定任务语义、压缩长期记忆和高保真短期交互。 | 给 Codex Worker 提供 `context.search`、`context.pin`、`context.checkpoint`，让它在需要时拉取上下文，而不是启动时全量灌入。 | 优先实现 |
| [Cognitive Scaffold](https://aclanthology.org/2026.acl-long.1170/), ACL 2026 | 把即时工作上下文与持久知识图分离；结构化事件快照避免普通摘要丢失实体和数值。 | 共享池采用事件 / 决策 / 证据图，不采用一篇会不断改写的“大摘要”。 | 优先实现 |
| [LightMem](https://aclanthology.org/2026.acl-long.588/), ACL 2026 | 把短、中、长期记忆分层，用小模型完成部分检索、写入和离线巩固，以固定在线预算运行。 | 低成本本地 embedding、关键词 / 路径检索和规则摘要先行；昂贵模型只负责必要的语义重写与冲突判断。 | 优先实现 |
| [MARS](https://arxiv.org/abs/2509.20502), 2025 preprint | “作者—独立审稿人—元审稿人”替代全员辩论；作者报告与多 Agent 辩论相近准确度下 Token 和时间约降 50%。 | 用星型审阅拓扑：Worker 向主 Agent 报告，Reviewer 独立检查，禁止 Worker 间默认群聊。 | 可直接采用 |
| [InfiAgent](https://aclanthology.org/2026.findings-acl.1787/), Findings of ACL 2026 | 以文件化状态快照和固定长度近期动作重建上下文，避免任务时间越长上下文越大。 | Mission 的“可见事实”应由任务状态、文件 / diff、产物索引和少量近期事件重建。 | 架构原则 |
| [OCR-Memory](https://aclanthology.org/2026.acl-long.474/), ACL 2026 | 用视觉化轨迹定位后再回取原文，试图减少长历史的文本常驻开销。 | 适合作为后续“时间线 / DAG 缩略图 + 点击回证据”的 UI 研究方向；不作为首版记忆载体。 | 探索 |

论文中的数字来自各自的基准与模型配置，不能直接等同于 Agent Deck 的实际节省比例。产品需要自己的评测集与成本遥测。

## 推荐架构：Context Kernel

```text
用户需求 / Mission
        │
        ▼
┌──────────────────────── Context Kernel ────────────────────────┐
│  1. Stable contract：目标、约束、验收、权限、工作区、预算           │
│  2. Working set：当前 Agent 最近高保真交互与当前任务状态             │
│  3. Checkpoints：已完成子目标的结构化结论、风险、下一步              │
│  4. Evidence graph：文件、diff、命令、测试、网页、产物、决策         │
│  5. Retrieval index：任务、路径、实体、语义向量、时间、置信度         │
└───────────────┬─────────────────────┬─────────────────────────┘
                │ Context capsule     │ context_ref
                ▼                     ▼
     ┌──────────────────┐     ┌──────────────────┐
     │ 主 Agent          │     │ Worker / Reviewer │
     │ 计划、路由、综合   │     │ 只拿当前任务所需集 │
     └───────┬──────────┘     └─────────┬────────┘
             │ 结构化事件 / 引用                  │ checkpoint / artifact
             └───────────────────────┬───────────┘
                                     ▼
                           SQLite + 本地文件 / Git
```

### 1. 永远注入的 Stable Contract

每次调用只保留少量不可丢失字段：`mission goal`、`task goal`、`acceptance`、`non-goals`、`workspace`、`权限边界`、`当前预算`。这部分应该是结构化 JSON 或紧凑文本，通常限制在 400–800 Token。

这解决“并行后每个子 Agent 理解不一样”：一致性来自稳定的任务契约，不来自复制所有对话。

### 2. Agent 私有 Working Set

一个真实 Codex 会话的近期消息、工具输出和正在处理的代码保持私有且高保真。不要把它广播到其他 Agent。每个 Agent 可保留最近若干轮或固定预算，例如 3,000–6,000 输入 Token；超过阈值时只对已完成阶段生成检查点。

### 3. 共享 Checkpoint，而不是共享 Transcript

每个任务在以下时机生成一个不可变检查点：开始、发现关键事实、完成一个子目标、遇到阻塞、准备交接、任务完成。

```json
{
  "task_id": "T3",
  "kind": "finding | decision | handoff | blocker | result",
  "summary": "一句话可执行结论",
  "facts": ["可验证事实"],
  "decisions": ["已确认取舍"],
  "open_questions": ["尚未解决的问题"],
  "next_action": "下一步",
  "evidence_refs": ["file:...#L42", "command:...", "artifact:..."],
  "confidence": "verified | reported | assumption",
  "token_cost": { "source": 0, "summary": 0 }
}
```

硬规则：没有 `evidence_refs` 的内容只能标记为 `reported` 或 `assumption`；不能作为下游 Agent 的“已证实事实”。这样压缩不会把猜测洗成事实。

### 4. Context Capsule：每次调用按任务装配

调度器在发送 prompt 前生成 `Context Capsule`：

```text
Stable contract                    600 tokens  必带
当前任务与依赖摘要                 700 tokens  必带
最近高保真本地交互                1,600 tokens  私有
按需检索的 3–6 条证据 / checkpoint 1,200 tokens  可变
任务输出预留                      1,200 tokens  预留
--------------------------------------------------
默认每轮输入预算                  4,100 tokens
```

Capsule 中只放内容，不放“所有曾经说过的话”。每条内容附 `context_ref` 和来源；Agent 可调用 `context.open(ref)` 拉取原文，系统会记录该拉取是否真正有用。

### 5. 消息总线改为引用式、定向式

禁止默认广播。总线消息的载荷应限制在紧凑 schema，并附上下文引用：

```json
{
  "to": "main-agent",
  "type": "result | question | review_request | blocker",
  "task_id": "T3",
  "headline": "测试发现接口兼容风险",
  "context_refs": ["checkpoint:cp_019", "file:api.ts#L42-L68"],
  "need_reply_by": "decision | information | none"
}
```

只有三种场景触发 Agent-to-Agent 消息：存在依赖、需要决策、请求评审。其余信息写入 Context Kernel，主 Agent 按需订阅。这样将通信复杂度从近似全连接的 `O(n²)` 降到任务 DAG 的实际边数 `O(E)`。

## Token 成本控制：产品级策略

### A. 先决策是否并行，再启动 Agent

并行不是默认动作。主 Agent 为每个候选任务计算一个简单门槛：

```text
expected_value = 等待时间节省 × 任务重要性 × 成功概率
parallel_cost  = 预估输入 + 预估输出 + 交接 + 审阅 + 冲突风险
只在 expected_value > parallel_cost 且没有文件冲突时派发
```

小任务、依赖强、需要共享同一段深度思考的任务留在主会话中；只有信息可分割、产物边界清楚的任务才并行。这是保护上下文连贯性的第一层，也是最大的成本杠杆。

### B. 星型审阅代替群聊

默认拓扑为：主 Agent → 并行 Worker → 主 Agent；必要时主 Agent → Reviewer → 主 Agent。Worker 之间没有常驻频道。MARS 的实验支持这种角色化、独立评审的组织方式：它避免 reviewer 间反复传话，论文报告相对多 Agent Debate 的 Token 和推理时间约减半。[MARS](https://arxiv.org/abs/2509.20502)

### C. 三段式预算与熔断

每个 Mission 和每个任务都有：

- **软预算**：到达后启用更短 Capsule、降低检索数量、禁止非必要消息。
- **硬预算**：到达后停止新 Agent 派发，只允许主 Agent 处理阻塞、汇总和用户确认。
- **收尾预留**：预算的一部分永远留给集成、测试、修复和最终报告，防止“前面研究很充分，后面没钱交付”。

UI 应实时显示：`总预算 / 已用 / 预测完成成本 / 本轮注入 Token / 重复上下文比例`，并在派发前展示“为什么值得并行”。

### D. 小模型做检索、排序、压缩；强模型做决策与编码

LightMem 的关键思路是在线检索和离线巩固分开，并用小模型承担部分记忆操作。[LightMem](https://aclanthology.org/2026.acl-long.588/) 在我们的实现中对应：本地 embedding、关键词 / 路径匹配、去重、schema 校验和粗摘要不消耗主模型；只有需要判断歧义、冲突或真正写代码时才调用 Codex。

### E. 缓存“上下文投影”，不缓存结论本身

以如下 key 缓存 Context Capsule：`task_id + task_revision + workspace_git_head + dependency_checkpoint_hash + agent_role`。同一状态下第二个 Reviewer 可复用稳定契约、索引和部分检索结果，但不能盲用第一个 Reviewer 的结论。代码变更、用户指令或依赖检查点变化会自动失效。

## Interlinked Files 的启发：把“轨迹检索”降到基础设施层

Interlinked Files 的公开定位不是多 Agent 编排，而是面向 Agent 的本地检索基础设施：常驻的本机文件 / 内容索引、从 Git 历史推导的文件关系、可附着到文件的知识笔记，以及暴露给 Codex、Claude Code 等客户端的 MCP 工具。[产品页](https://www.interlinkedfiles.com/search) 和 [技术说明](https://www.interlinkedfiles.com/research/mcp-server-file-search) 声称可将多次 `find` / `grep` 探索压缩为一次索引查询。

其性能数字来自厂商在特定机器上的测试，不能当作通用基准；但问题定义非常准确：Agent 的大量 Token 并不花在推理，而是花在“猜路径 → 查目录 → grep → 读错文件 → 再查”的轨迹中。每次工具调用都会让模型重读不断增长的历史，因而搜索噪声会复利式污染上下文。[其案例说明](https://www.interlinkedfiles.com/research/how-many-tool-calls-to-find-a-file)

### 我们应该吸收的四件事

| Interlinked 的思想 | 为什么有效 | Agent Deck 中的产品化方式 |
|---|---|---|
| **实时、本地、常驻索引** | 一次查准文件，避免多轮 shell 探索和工具输出污染会话 | 每个已授权 workspace 建本地索引；文件保存、Git HEAD、worktree 创建后增量更新 |
| **文件关系而非只有文本相似度** | “一起改过”的文件常比“语义相似”的文件更接近当前改动 | 从 Git 共变、import、测试覆盖、任务依赖构建边；检索时以文件为种子扩展 1–2 跳 |
| **知识随对象绑定** | 记忆跟着文件身份和版本，不只跟着当前路径或某个聊天窗口 | Checkpoint 的证据绑定 `repo + git blob / commit + path history + line range`，重命名仍可追踪 |
| **MCP 工具应当易被模型正确选择** | 低延迟工具如果描述不清，模型仍会选 grep | 对外只暴露少量动作明确的工具，写清“什么时候调用、返回什么、何时不要调用” |

### 从“文件检索”升级为“轨迹检索”

Interlinked 的文件索引应是我们 Context Kernel 的一个数据源，而不是整个记忆系统。Agent Deck 还拥有它没有的编排语义：Mission、任务 DAG、Agent、运行、决策、消息、产物、测试与用户审批。因此需要建立 **Trajectory Index**：

```text
任务 / 用户问题
        │
        ▼
┌─────────── 1. 精确检索 ───────────┐
│ task_id · mission_id · 文件身份      │  低延迟、零模型调用
│ git commit · worktree · agent · 时间 │
└────────────────┬──────────────────┘
                 ▼
┌─────────── 2. 关系扩展 ───────────┐
│ DAG 上下游 · Git 共变 · import      │  只取 1–2 跳、带权重
│ 检查点父子关系 · 评审 / 产物引用     │
└────────────────┬──────────────────┘
                 ▼
┌─────────── 3. 意图重排 ───────────┐
│ 当前子任务 + 问题类型 + 验收标准      │  小模型 / embedding / 规则
│ 新鲜度 + 证据等级 + Token 预算        │
└────────────────┬──────────────────┘
                 ▼
          Context Capsule（引用 + 短摘）
```

Agent 获取的不是一整段“过去发生了什么”，而是：

1. **当前任务必须知道的稳定契约**；
2. **最相关的 3–6 个带证据的轨迹片段**；
3. **可展开的引用**，例如 `run:R14/output#L31`、`file:handler.go@blob:abc#L80-L124`、`decision:D7`；
4. **为什么被召回**，例如“与当前文件共变 6 次”“是上游 T2 的已验证结论”“来自当前 worktree 的最新测试”。

这使“上下文”从不可解释的 RAG 结果变成一个用户和 Agent 都能检查的因果路径。

### Agent Deck MCP：建议的最小工具面

不要直接提供几十个细碎工具；先提供四个可组合、低噪声的能力：

| 工具 | 返回内容 | 何时调用 |
|---|---|---|
| `trajectory.find` | 精确匹配的任务、文件、运行或决策 refs | 已知名称、路径、Task Key、报错或 commit 时 |
| `trajectory.related` | DAG / Git 共变 / import 关系中的小邻域 | 已打开一个文件或已定位一条证据，想知道“还该看什么”时 |
| `context.brief` | 受 Token 预算约束的 Context Capsule | 开始一个任务、恢复会话、交接给 Reviewer 时 |
| `context.open` | 某条 ref 的原始文件、命令输出或完整会话区间 | Capsule 不足以作决定时；按需展开，绝不默认注入 |

工具描述本身要被当作产品资产测试。Interlinked 的研究强调，模型能否选到一个工具，很大程度取决于工具的名称与一句话描述，而不仅是底层查询速度。[How does an AI agent decide which tool to call?](https://www.interlinkedfiles.com/research/how-does-an-agent-choose-a-tool)

### 安全与边界：不照搬“全机器索引”

Interlinked 的价值主张是全机检索；Agent Deck 的默认策略应更保守：**只索引用户显式选择的工作区及其 worktree**。跨工作区检索必须是用户开启的选项，并在 Capsule 中明确显示来源。这样既保持本地优先，也避免一个任务意外读到另一项目的机密内容。

### 可立即进入路线图的 V0.5.1

1. 在现有 SQLite 中新增 `trajectory_nodes`、`trajectory_edges`、`file_identities` 三类表；先记录已有 Mission / Task / Artifact / Message / Run，不需要向量数据库。
2. 增量收集 `git diff`、`git log --name-status`、当前 worktree 文件清单，生成文件—任务、文件—文件共变、任务—证据边。
3. 实现确定性 `trajectory.find`：Task Key、文件路径、错误文本、命令、commit 和最近时间优先；先用 SQLite FTS5 / 关键词，不急于上昂贵 embedding。
4. 实现 `context.brief`，在 UI 展示“本轮注入 2,180 Token：稳定契约 610、依赖检查点 740、文件证据 830；未注入 14 条低相关轨迹”。
5. 用现有真实 Mission 回放对比：`grep/目录探索次数`、`重复 read_file 次数`、`工具输出 Token`、`命中证据后的成功率`。

这条路径比先训练一个“记忆 Agent”更适合现在的桌面端：成本低、完全本地、可验证，也能让用户直接感知为什么多 Agent 没有变得更慢、更贵、更糊涂。

### V0.5.1 已落地（本地桌面版）

- SQLite 已持久化 `trajectory_nodes`、`trajectory_edges` 与 `file_identities`。索引来自真实的 Mission、Task、Artifact、Message、Run 和 Event，不会伪造模型进度。
- `missions:context-search` 提供确定性本地检索：任务、标题、摘要、文件路径、可追溯引用和验证等级共同排序；每项返回 `ref`、命中原因和关联边。
- `missions:context-brief` 以 token 预算形成 Capsule：稳定任务契约、当前任务、上游依赖检查点和高相关证据分层装入；默认不复制原始会话全文。
- 新建 Worker 时，Capsule 已真正拼入 Codex 的 Worker Prompt，同时在 Event Ledger 记录估算 Token、基线 Token、带入条数和未带入条数。
- Mission 顶部新增 **Context** 面板：可查看本轮注入、相对全量轨迹的估算减少比例、每条证据的原因与引用，并能检索本地轨迹。

这里的 Token 是跨模型的本地估算值，不冒充任何供应商的精确 tokenizer 计费；精确消耗仍应以后续接入的 provider usage 为准。

## 防止上下文丢失：质量护栏

1. **不压缩原始证据**：原始对话、命令输出、文件版本、diff、测试日志永久可打开；压缩物只是一层索引。
2. **摘要有版本与父引用**：每个 Checkpoint 记录输入 refs、生成模型、时间、版本；错误摘要可回滚。
3. **区分事实等级**：`verified / reported / assumption / stale` 四级可视化，禁止把 assumption 自动提升为 verified。
4. **检索先看任务意图**：查询必须包含当前任务、目标、文件边界和问题类型，防止“语义相似但目标不同”的错误记忆进入上下文。
5. **信息缺口显式化**：Capsule 最后一段固定写 `Unknowns & conflicts`；不允许模型用旧摘要静默填空。
6. **可回放评测**：保存 Capsule、检索列表、Agent 输出、最终结果，才能回答“哪个上下文帮助了这次任务、哪个只是花钱”。

## 适合 Agent Deck 的实施顺序

| 版本 | 交付 | 为什么先做 | 验收指标 |
|---|---|---|---|
| V0.5 Context Kernel | Checkpoint schema、evidence refs、Capsule builder、上下文来源面板 | 不依赖模型训练，直接改善可解释性 | 每次 Worker 启动都可看到“带了什么、为什么带、多少 Token” |
| V0.6 Budgeted orchestration | 任务 / Mission 预算、派发前成本预测、软硬熔断、去重消息 | 控制多开会话的真实成本 | 同一任务可比较单 Agent / 并行 Agent 的 Token、时延、质量 |
| V0.7 Retrieval & memory | 本地索引、任务意图检索、固定检索预算、离线记忆巩固 | 让历史可用而不常驻 | 已完成任务能用少量 Capsule 恢复关键事实，且能回链证据 |
| V0.8 Topology & evaluation | 并行收益门槛、星型审阅、冲突预测、回放基准 | 让多 Agent 只在值得时出现 | 任务成功率不低于单会话基线，单位成功任务 Token 更低 |
| 研究项 | KV-cache / latent 通信 | 对同模型、本地推理或开放模型潜力很大；闭源异构模型暂不稳定 | 先做实验开关，不进入默认链路 |

## 我们应该做得比“多窗口工具”更好的地方

不是简单地将多个 Codex 窗口并列，而是做到：

- 用户始终能看见每个 Agent **知道什么、忽略什么、为什么**。
- 用户可以在任何时刻把一条事实 pin 到任务契约，或将某条错误结论标为过期。
- 系统可以解释每次派发的预估收益和成本，而不是“多叫几个 Agent 试试”。
- 单会话和多会话共享同一套 Context Kernel，因此从一个人专注工作切到并行协作时，语义不会断层。

## 需要先建立的产品基准

用 20–30 个真实 Agent Deck 任务组成回放集，每个任务至少跑三种策略：单会话、朴素并行、Context Kernel 并行。每次记录：

- 成功率、人工返工次数、测试 / 证据完整度。
- 输入 / 输出 Token、每个 Agent 的上下文 Token、重复注入比例。
- 从需求到可验收产物的墙钟时间。
- 关键事实召回率：人工标注的决定、约束、文件边界是否被正确保留。
- 错误归因：检索错、压缩错、路由错、模型执行错还是用户需求变化。

只有当“Context Kernel 并行”在质量不低于单会话的前提下，显著降低重复 Token 或缩短交付时间，才应该默认启用多 Agent。

## 参考文献

1. Huiqiang Jiang et al. [LLMLingua: Compressing Prompts for Accelerated Inference of Large Language Models](https://aclanthology.org/2023.emnlp-main.825.pdf). EMNLP 2023.
2. Huiqiang Jiang et al. [LongLLMLingua: Accelerating and Enhancing LLMs in Long Context Scenarios via Prompt Compression](https://arxiv.org/abs/2310.06839). 2023.
3. Charles Packer et al. [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560). 2023.
4. Mengkang Hu et al. [HiAgent: Hierarchical Working Memory Management for Solving Long-Horizon Agent Tasks with Large Language Model](https://aclanthology.org/2025.acl-long.1575/). ACL 2025.
5. Shukai Liu et al. [Context as a Tool: Context Management for Long-Horizon SWE-Agents](https://aclanthology.org/2026.findings-acl.1032/). Findings of ACL 2026.
6. Qiuyuan Ai et al. [Cognitive Scaffold: From Fluid Context to Crystallized Memory for Long-Horizon DeepResearch Agents](https://aclanthology.org/2026.acl-long.1170/). ACL 2026.
7. Jiaquan Zhang et al. [Lightweight LLM Agent Memory with Small Language Models](https://aclanthology.org/2026.acl-long.588/). ACL 2026.
8. Xiaowei Wang et al. [MARS: Toward More Efficient Multi-Agent Collaboration for LLM Reasoning](https://arxiv.org/abs/2509.20502). 2025 preprint.
9. Chenglin Yu et al. [InfiAgent: An Infinite-Horizon Framework for General-Purpose Autonomous Agents](https://aclanthology.org/2026.findings-acl.1787/). Findings of ACL 2026.
10. Jinze Li et al. [OCR-Memory: Optical Context Retrieval for Long-Horizon Agent Memory](https://aclanthology.org/2026.acl-long.474/). ACL 2026.
