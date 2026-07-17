import type { ExportResult } from "./domain/types";

export function formatExportSuccess(result: ExportResult): string {
  const skipped = result.taskCounts.skipped > 0
    ? `；跳过：未开始 ${result.taskCounts.notStarted}、进行中 ${result.taskCounts.inProgress}、异常 ${result.taskCounts.invalid}`
    : "";
  return `已导出 ${result.taskCount} 个已完成任务（批次${result.status === "complete" ? "完整" : "部分完成"}${skipped}）：${result.outputPath}`;
}
