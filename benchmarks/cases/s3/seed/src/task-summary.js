export function summarizeTasks(tasks) {
  const completed = tasks.filter((task) => task.status === "completed").length;
  return { total: tasks.length, completed, pending: tasks.length - completed };
}

export function toText(summary) {
  return `Tasks: ${summary.total}\nCompleted: ${summary.completed}\nPending: ${summary.pending}\n`;
}
