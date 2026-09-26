export function ExecutionModeField({ value, onChange }) {
  return <label>工作类型
    <select value={value} onChange={event => onChange(event.target.value)}>
      <option value="code">代码开发 · 隔离修改项目</option>
      <option value="research">调研与文档 · 独立生成成果</option>
    </select>
    <small>{value === "research"
      ? "普通文件夹即可作为资料目录。成果写入应用独立工作区，内部版本管理自动准备，不修改原项目。"
      : "需要有提交记录的 Git 项目。每个 Worker 在独立 Worktree 中开发，验收后再集成。"}</small>
  </label>;
}
