# Simple tier：Agent Deck 与直接 Codex 首轮配对结果

## 同档结果

模型均为 `gpt-5.6-terra`，推理档位均为 `medium`。每个配对使用相同的仓库 seed、任务文本、公开测试与隐藏 grader。Agent Deck 采用 Direct 路由：0 Planner、1 Worker、一个 worktree、一次最终人工验收。

| Case | 直接 Codex `T_green` | Agent Deck `T_green` | Agent Deck / Codex | 隐藏检查 | Agent Deck 人工触点 | 结论 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| S1 Retry-After | 100.4s | 89.7s | `0.893x` | 双方 7/7 | 1 | Agent Deck 快 10.7% |
| S2 深层脱敏 | 74.2s | 82.0s | `1.104x` | 双方 6/6 | 1 | Agent Deck 慢 10.4%，接近 `1.10x` 门槛 |
| S3 CLI `--json` | 71.1s | 69.4s | `0.977x` | 双方 5/5 | 2 | Agent Deck 快 2.3%；本轮另有一次写入审批 |

三题速度比的几何平均为 `0.988x`，即首轮样本中 Agent Deck 与直接 Codex 基本持平并略快 1.2%。三题确定性质量均为 80/80。样本量仍然太小，不能据此宣称统计意义上的性能领先。

自动汇总器当前按每组最新有效样本执行门禁。为验证 Token 真值而新增的 S1 Agent Deck 样本为 157.7 秒，使最新 S1 比值变为 `1.570x`，当前自动门禁因此为 `fail`，三题最新样本几何平均为 `1.192x`。这正是后续必须补足至少 3 次配对并改用分位数报告的原因；上表仅保留首次同档配对，不代表稳定性能结论。

## 优化收益

取消 Direct Worker 的强制 JSON 响应，并把自然语言总结与 Git/测试证据在本地组合后：

| Case | 优化前 Agent Deck | 优化后 Agent Deck | 降幅 | 质量变化 |
| --- | ---: | ---: | ---: | --- |
| S1 | 188.3s（high） | 89.7s（medium） | 52.4% | 隐藏 7/7 保持 |
| S2 | 106.0s（high） | 82.0s（medium） | 22.7% | 隐藏 6/6 保持 |
| S3 | 149.1s（medium） | 69.4s（medium） | 53.5% | 隐藏 5/5 保持 |

S3 新版阶段分解：控制面 2.119 秒、Worker 63.105 秒、自动集成 3.000 秒、grader 0.603 秒。产品固定开销约 5.1 秒；主要波动仍来自模型 Worker 回合。

## 实验异常与解释边界

- S2 的直接 Codex `high` 样本在 600 秒超时且无 diff。
- S3 的首次直接 Codex `medium` 样本停在 `fileChange/requestApproval`，因为无 UI 的评测器没有响应审批；修正评测协议后为 71.1 秒并全部通过。
- 评测器现在会在隔离临时仓库中自动接受审批并计入人工触点，避免把“无人点按钮”误记为推理超时。
- 单轮模型延迟方差很大。后续结论必须基于每个 case 至少 3 次有效配对，并报告 P50、P95、超时率和质量分布。

## 下一步判定

1. 建立 benchmark 汇总器，自动读取 JSON 结果并输出 HTML/JSON 报告。
2. 每个简单 case 再补至少 2 次同档配对，启用 `T_green <= 1.10x` 与质量不降的门禁。
3. 聚合实际工具批次，并用后续配对样本比较双方真实 Provider Token。
4. 开始 M1–M3 中等任务夹具，验证多 Agent 是否能用质量、关键路径或返工率抵消协调成本。

## Token 真值进展

2026-09-27 的真实 S1 复跑已验证 `thread/tokenUsage/updated` 能进入 Mission Token 用量记录：`tokenSource=provider_reported`，本轮总 Token 为 30,847。账本按 turn 取最后累计值，避免把同一 turn 的多次增量事件重复相加，并分别记录 input、cached input、output 与 reasoning output。该样本也超过了 20,000 的计划预算，说明下一阶段必须实现运行中的 Token Budget Governor，而不能只展示预算。
