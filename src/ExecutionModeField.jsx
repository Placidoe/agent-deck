export function ExecutionModeField({ value, onChange }) {
  return <label>工作类型
    <select value={value} onChange={event => onChange(event.target.value)}>
      <option value="code">代码开发 · 隔离修改项目</option>
      <option value="research">调研与文档 · 独立生成成果</option>
    </select>
    <small>{value === "research"
      ? "所选文件夹作为只读资料；读取的内容可能提供给所选模型。成果写入独立工作区，不修改原项目。自有 Harness 读取公开网页前会请求批准。"
      : "需要有提交记录的 Git 项目。每个 Worker 在独立 Worktree 中开发，验收后再集成。"}</small>
  </label>;
}
