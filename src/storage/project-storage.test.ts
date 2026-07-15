import { describe, expect, it } from "vitest";
import { captionFixture } from "../test/caption-fixture";
import { BrowserProjectStorage } from "./project-storage";

function projectFile(name: string, content: string, relativePath: string, type: string) {
  const file = new File([content], name, { type });
  Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
  return file;
}

function captionRow(videoPath: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ ...captionFixture, video_path: videoPath, ...overrides });
}

describe("BrowserProjectStorage JSONL import", () => {
  it("loads each JSONL row and matches its nested video_path exactly", async () => {
    const storage = new BrowserProjectStorage();
    const row = captionRow("media-batch/video_clips/group-a/clip_01.mp4");
    const files = [
      projectFile(
        "scenes_batch_final_caption_zh.jsonl",
        row,
        "batch/scenes_batch_final_caption_zh.jsonl",
        "application/x-ndjson",
      ),
      projectFile(
        "clip_01.mp4",
        "video",
        "batch/media-batch/video_clips/group-a/clip_01.mp4",
        "video/mp4",
      ),
    ] as unknown as FileList;

    const project = await storage.openFiles(files);

    expect(project.name).toBe("batch");
    expect(project.tasks).toHaveLength(1);
    expect(project.tasks[0]).toMatchObject({
      id: "clip_01",
      status: "not_started",
      jsonPath: "scenes_batch_final_caption_zh.jsonl",
      videoPath: "media-batch/video_clips/group-a/clip_01.mp4",
    });
    expect(project.tasks[0]!.document?.caption_en).toBe(captionFixture.caption_en);
    expect(project.tasks[0]!.document?.caption_zh).toBe(captionFixture.caption_zh);
  });

  it("keeps JSONL filename order, line order, and missing-video rows as invalid tasks", async () => {
    const storage = new BrowserProjectStorage();
    const files = [
      projectFile(
        "scenes_z_final_caption_zh.jsonl",
        captionRow("z/second.mp4"),
        "batch/scenes_z_final_caption_zh.jsonl",
        "application/x-ndjson",
      ),
      projectFile(
        "scenes_a_final_caption_zh.jsonl",
        [captionRow("a/first.mp4"), "{bad-json", captionRow("a/missing.mp4")].join("\n"),
        "batch/scenes_a_final_caption_zh.jsonl",
        "application/x-ndjson",
      ),
      projectFile("first.mp4", "video", "batch/a/first.mp4", "video/mp4"),
      projectFile("second.mp4", "video", "batch/z/second.mp4", "video/mp4"),
    ] as unknown as FileList;

    const project = await storage.openFiles(files);

    expect(project.tasks.map((task) => task.id)).toEqual([
      "first",
      "scenes_a_final_caption_zh.line-2",
      "missing",
      "second",
    ]);
    expect(project.tasks[1]!.error).toContain("第 2 行不是有效 JSON");
    expect(project.tasks[2]!.error).toContain("视频不存在");
    expect(project.tasks[3]!.status).toBe("not_started");
  });

  it("rejects unsafe paths, non-MP4 paths, and duplicate video_path values", async () => {
    const storage = new BrowserProjectStorage();
    const rows = [
      captionRow("../outside.mp4"),
      captionRow("clips/not-video.mov"),
      captionRow("clips/repeated.mp4"),
      captionRow("clips/repeated.mp4"),
    ].join("\n");
    const files = [
      projectFile(
        "scenes_batch_final_caption_zh.jsonl",
        rows,
        "batch/scenes_batch_final_caption_zh.jsonl",
        "application/x-ndjson",
      ),
      projectFile("repeated.mp4", "video", "batch/clips/repeated.mp4", "video/mp4"),
    ] as unknown as FileList;

    const project = await storage.openFiles(files);

    expect(project.tasks[0]!.error).toContain("路径越界");
    expect(project.tasks[1]!.error).toContain("必须指向 MP4");
    expect(project.tasks[2]!.error).toContain("重复 video_path");
    expect(project.tasks[3]!.error).toContain("重复 video_path");
    expect(new Set(project.tasks.map((task) => task.id)).size).toBe(4);
  });

  it("adds a stable hash suffix to every colliding MP4 stem", async () => {
    const storage = new BrowserProjectStorage();
    const rows = [captionRow("one/shared.mp4"), captionRow("two/shared.mp4")].join("\n");
    const files = [
      projectFile(
        "scenes_batch_final_caption_zh.jsonl",
        rows,
        "batch/scenes_batch_final_caption_zh.jsonl",
        "application/x-ndjson",
      ),
      projectFile("shared.mp4", "one", "batch/one/shared.mp4", "video/mp4"),
      projectFile("shared.mp4", "two", "batch/two/shared.mp4", "video/mp4"),
    ] as unknown as FileList;

    const project = await storage.openFiles(files);

    expect(project.tasks).toHaveLength(2);
    expect(project.tasks.every((task) => /^shared-[a-f0-9]{8}$/.test(task.id))).toBe(true);
    expect(project.tasks[0]!.id).not.toBe(project.tasks[1]!.id);
  });

  it("requires at least one root-level scenes JSONL file", async () => {
    const storage = new BrowserProjectStorage();
    const files = [
      projectFile("clip.mp4", "video", "batch/clips/clip.mp4", "video/mp4"),
      projectFile(
        "scenes_nested_final_caption_zh.jsonl",
        captionRow("clips/clip.mp4"),
        "batch/nested/scenes_nested_final_caption_zh.jsonl",
        "application/x-ndjson",
      ),
    ] as unknown as FileList;

    await expect(storage.openFiles(files)).rejects.toThrow("根目录下未找到 scenes_*_final_caption_zh.jsonl");
  });

  it("discards legacy decisions when restoring a Caption JSONL task", async () => {
    const storage = new BrowserProjectStorage();
    const files = [
      projectFile(
        "scenes_legacy_final_caption_zh.jsonl",
        captionRow("clips/1.mp4"),
        "legacy-batch/scenes_legacy_final_caption_zh.jsonl",
        "application/x-ndjson",
      ),
      projectFile("1.mp4", "video", "legacy-batch/clips/1.mp4", "video/mp4"),
    ] as unknown as FileList;
    const first = await storage.openFiles(files);
    first.tasks[0]!.records = {
      "overview.overall_visual_style": {
        unitId: "overview.overall_visual_style",
        decision: "correct",
        correctedFields: {},
        updatedAt: "2026-07-14T00:00:00.000Z",
      } as never,
    };
    await storage.saveProject(first);

    const restored = await storage.openFiles(files);
    expect(restored.tasks[0]!.records).toEqual({});
  });
});
