import { describe, expect, it } from "vitest";
import { formatExportSuccess } from "./export-message";

describe("export result messaging", () => {
  it("reports exported completed tasks and every skipped status", () => {
    expect(formatExportSuccess({
      outputPath: "/project/exports/20260717-120000",
      status: "partial",
      taskCount: 2,
      taskCounts: {
        total: 8,
        exported: 2,
        notStarted: 3,
        inProgress: 2,
        complete: 2,
        invalid: 1,
        skipped: 6,
      },
    })).toBe("已导出 2 个已完成任务（批次部分完成；跳过：未开始 3、进行中 2、异常 1）：/project/exports/20260717-120000");
  });
});
