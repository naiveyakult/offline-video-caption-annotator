import { describe, expect, it, vi } from "vitest";
import { buildAnnotationUnits } from "../domain/annotation";
import { captionFixture } from "../test/caption-fixture";
import type { ProjectTask } from "../domain/types";
import { BrowserProjectStorage, updateTaskStatus } from "./project-storage";

function projectFile(name: string, content: string, relativePath: string, type: string) {
  const file = new File([content], name, { type });
  Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
  return file;
}

function captionRow(videoPath: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ ...captionFixture, video_path: videoPath, ...overrides });
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

function completeTask(task: ProjectTask): ProjectTask {
  if (!task.document) throw new Error("测试任务必须有效");
  const records = Object.fromEntries(buildAnnotationUnits(task.document).map((unit, index) => [
    unit.id,
    {
      unitId: unit.id,
      decision: "question" as const,
      correctedFields: {},
      updatedAt: `2026-07-17T00:00:${String(index).padStart(2, "0")}.000Z`,
    },
  ]));
  return updateTaskStatus({ ...task, records });
}

describe("BrowserProjectStorage JSONL import", () => {
  it("normalizes file bytes to a typed array before WebCrypto hashing", async () => {
    const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
    const digest = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      expect(ArrayBuffer.isView(data)).toBe(true);
      return nativeDigest(algorithm, data);
    });
    const storage = new BrowserProjectStorage();
    const files = [
      projectFile(
        "scenes_batch_final_caption_zh.jsonl",
        captionRow("clips/clip.mp4"),
        "batch/scenes_batch_final_caption_zh.jsonl",
        "application/x-ndjson",
      ),
      projectFile("clip.mp4", "video", "batch/clips/clip.mp4", "video/mp4"),
    ] as unknown as FileList;

    try {
      await storage.openFiles(files);
      expect(digest).toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
  });

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

  it("restores existing v0.3 decisions together with the new Question decision", async () => {
    const storage = new BrowserProjectStorage();
    const files = [
      projectFile(
        "scenes_compat_final_caption_zh.jsonl",
        captionRow("clips/1.mp4"),
        "compat-batch/scenes_compat_final_caption_zh.jsonl",
        "application/x-ndjson",
      ),
      projectFile("1.mp4", "video", "compat-batch/clips/1.mp4", "video/mp4"),
    ] as unknown as FileList;
    const first = await storage.openFiles(files);
    first.tasks[0]!.records = {
      "overview.overall_visual_style": {
        unitId: "overview.overall_visual_style",
        decision: "true",
        correctedFields: {},
        updatedAt: "2026-07-14T00:00:00.000Z",
      },
      "overview.overall_audio_style": {
        unitId: "overview.overall_audio_style",
        decision: "false",
        correctedFields: { overall_audio_style: "Corrected audio." },
        updatedAt: "2026-07-14T00:00:01.000Z",
      },
      "overview.character_profiles.0": {
        unitId: "overview.character_profiles.0",
        decision: "other",
        correctedFields: {},
        updatedAt: "2026-07-14T00:00:02.000Z",
      },
      "overview.narrative_theme": {
        unitId: "overview.narrative_theme",
        decision: "question",
        correctedFields: {},
        updatedAt: "2026-07-14T00:00:03.000Z",
      },
    };
    first.tasks[0]!.drafts = {
      "speech_transcript.0": {
        unitId: "speech_transcript.0",
        decision: "false",
        fields: { speaker: "Speaker A", state: "Calm", content: "Draft content." },
        updatedAt: "2026-07-14T00:00:04.000Z",
      },
    };
    first.tasks[0]!.videoPosition = 12.34;
    await storage.saveProject(first);

    const restored = await storage.openFiles(files);
    expect(Object.values(restored.tasks[0]!.records).map((record) => record.decision)).toEqual([
      "true",
      "false",
      "other",
      "question",
    ]);
    expect(restored.tasks[0]!.drafts["speech_transcript.0"]?.fields.content).toBe("Draft content.");
    expect(restored.tasks[0]!.videoPosition).toBe(12.34);
  });

  it("preserves saved annotations while a task has a media anomaly and restores them after it clears", async () => {
    let audioTracks = 1;
    const storage = new BrowserProjectStorage(async () => audioTracks);
    const files = [
      projectFile(
        "scenes_restore_final_caption_zh.jsonl",
        captionRow("clips/1.mp4"),
        "restore-batch/scenes_restore_final_caption_zh.jsonl",
        "application/x-ndjson",
      ),
      projectFile("1.mp4", "video", "restore-batch/clips/1.mp4", "video/mp4"),
    ] as unknown as FileList;
    const first = await storage.openFiles(files);
    first.tasks[0]!.records = {
      "overview.overall_visual_style": {
        unitId: "overview.overall_visual_style",
        decision: "true",
        correctedFields: {},
        updatedAt: "2026-07-21T00:00:00.000Z",
      },
    };
    first.tasks[0]!.drafts = {
      "speech_transcript.0": {
        unitId: "speech_transcript.0",
        decision: "false",
        fields: { content: "saved draft" },
        updatedAt: "2026-07-21T00:00:01.000Z",
      },
    };
    first.tasks[0]!.videoPosition = 8.5;
    await storage.saveProject(first);

    audioTracks = 2;
    const abnormal = await storage.openFiles(files);
    expect(abnormal.tasks[0]).toMatchObject({
      status: "invalid",
      mediaAnomaly: { code: "multiple_audio_tracks", audioTrackCount: 2 },
      videoPosition: 8.5,
    });
    expect(abnormal.tasks[0]!.records["overview.overall_visual_style"]?.decision).toBe("true");
    expect(abnormal.tasks[0]!.drafts["speech_transcript.0"]?.fields.content).toBe("saved draft");
    await storage.saveProject(abnormal);

    audioTracks = 1;
    const restored = await storage.openFiles(files);
    expect(restored.tasks[0]!.status).toBe("in_progress");
    expect(restored.tasks[0]!.mediaAnomaly).toBeUndefined();
    expect(restored.tasks[0]!.records["overview.overall_visual_style"]?.decision).toBe("true");
    expect(restored.tasks[0]!.drafts["speech_transcript.0"]?.fields.content).toBe("saved draft");
  });

  it("exports only completed tasks and keeps every task in the schema 2.3 manifest", async () => {
    const storage = new BrowserProjectStorage();
    const rows = [
      captionRow("clips/complete.mp4"),
      captionRow("clips/progress.mp4"),
      captionRow("clips/pending.mp4"),
      captionRow("clips/missing.mp4"),
    ].join("\n");
    const files = [
      projectFile(
        "scenes_export_final_caption_zh.jsonl",
        rows,
        "export-batch/scenes_export_final_caption_zh.jsonl",
        "application/x-ndjson",
      ),
      projectFile("complete.mp4", "video", "export-batch/clips/complete.mp4", "video/mp4"),
      projectFile("progress.mp4", "video", "export-batch/clips/progress.mp4", "video/mp4"),
      projectFile("pending.mp4", "video", "export-batch/clips/pending.mp4", "video/mp4"),
    ] as unknown as FileList;
    const project = await storage.openFiles(files);
    project.tasks[0] = completeTask(project.tasks[0]!);
    project.tasks[1] = updateTaskStatus({ ...project.tasks[1]!, records: {
      "overview.overall_visual_style": {
        unitId: "overview.overall_visual_style",
        decision: "question",
        correctedFields: {},
        updatedAt: "2026-07-14T00:00:00.000Z",
      },
    } });
    const blobs: Blob[] = [];
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      if (!(blob instanceof Blob)) throw new Error("导出内容必须使用 Blob");
      blobs.push(blob);
      return `blob:export-${blobs.length}`;
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    try {
      const result = await storage.exportProject(project, "A023");
      expect(result.taskCount).toBe(1);
      expect(result.taskCounts).toEqual({
        total: 4,
        exported: 1,
        notStarted: 1,
        inProgress: 1,
        complete: 1,
        invalid: 1,
        skipped: 3,
      });
      expect(blobs).toHaveLength(3);
      const meta = JSON.parse(await readBlob(blobs[1]!)) as { schema_version: string; export_status: string };
      const manifest = JSON.parse(await readBlob(blobs.at(-1)!)) as {
        schema_version: string;
        export_status: string;
        task_counts: Record<string, number>;
        annotation_counts: Record<string, number>;
        tasks: Array<Record<string, unknown>>;
      };
      expect(meta.schema_version).toBe("2.2");
      expect(meta.export_status).toBe("complete");
      expect(manifest.schema_version).toBe("2.3");
      expect(manifest.export_status).toBe("partial");
      expect(manifest.task_counts).toEqual({
        total: 4,
        exported: 1,
        not_started: 1,
        in_progress: 1,
        complete: 1,
        invalid: 1,
        skipped: 3,
      });
      expect(manifest.annotation_counts).toEqual({
        total: 9,
        pending: 0,
        true: 0,
        false: 0,
        question: 9,
        other: 0,
      });
      expect(manifest.tasks).toMatchObject([
        { task_id: "complete", task_status: "complete", export_status: "complete" },
        { task_id: "progress", task_status: "in_progress", export_status: "skipped", skipped_reason: "任务尚未完成" },
        { task_id: "pending", task_status: "not_started", export_status: "skipped", skipped_reason: "任务尚未开始" },
        { task_id: "missing", task_status: "invalid", export_status: "skipped" },
      ]);
    } finally {
      createObjectUrl.mockRestore();
      click.mockRestore();
    }
  });

  it("records media anomaly details in the manifest and skips its task files", async () => {
    const storage = new BrowserProjectStorage(async () => 2);
    const files = [
      projectFile(
        "scenes_multi_final_caption_zh.jsonl",
        captionRow("clips/multi.mp4"),
        "multi-batch/scenes_multi_final_caption_zh.jsonl",
        "application/x-ndjson",
      ),
      projectFile("multi.mp4", "video", "multi-batch/clips/multi.mp4", "video/mp4"),
    ] as unknown as FileList;
    const project = await storage.openFiles(files);
    const task = project.tasks[0]!;
    expect(task.document).toBeDefined();
    expect(task.status).toBe("invalid");
    expect(task.error).toBeUndefined();
    expect(task.mediaAnomaly).toMatchObject({ code: "multiple_audio_tracks", audioTrackCount: 2 });

    task.records = completeTask({ ...task, mediaAnomaly: undefined, status: "not_started" }).records;
    const healthy = completeTask({
      ...task,
      id: "healthy",
      videoPath: "clips/healthy.mp4",
      mediaAnomaly: undefined,
      status: "not_started",
    });
    const blobs: Blob[] = [];
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return `blob:export-${blobs.length}`;
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    try {
      await storage.exportProject({ ...project, tasks: [healthy, task] }, "A023");
      const manifest = JSON.parse(await readBlob(blobs.at(-1)!)) as { tasks: Array<Record<string, unknown>> };
      expect(manifest.tasks[1]).toMatchObject({
        task_status: "invalid",
        export_status: "skipped",
        anomaly_code: "multiple_audio_tracks",
        audio_track_count: 2,
      });
      expect(String(manifest.tasks[1]!.skipped_reason)).toContain("多音轨");
    } finally {
      createObjectUrl.mockRestore();
      click.mockRestore();
    }
  });

  it("marks audio inspection failures as media anomalies without discarding the Caption document", async () => {
    const storage = new BrowserProjectStorage(async () => {
      throw new Error("container is damaged");
    });
    const files = [
      projectFile(
        "scenes_broken_final_caption_zh.jsonl",
        captionRow("clips/broken.mp4"),
        "broken-batch/scenes_broken_final_caption_zh.jsonl",
        "application/x-ndjson",
      ),
      projectFile("broken.mp4", "broken", "broken-batch/clips/broken.mp4", "video/mp4"),
    ] as unknown as FileList;

    const project = await storage.openFiles(files);

    expect(project.tasks[0]!.document).toBeDefined();
    expect(project.tasks[0]!.error).toBeUndefined();
    expect(project.tasks[0]!.mediaAnomaly).toMatchObject({
      code: "audio_track_detection_failed",
      message: "音轨检测失败：container is damaged",
    });
    expect(project.tasks[0]!.status).toBe("invalid");
  });

  it("does not create downloads when there are no completed tasks", async () => {
    const storage = new BrowserProjectStorage();
    const files = [
      projectFile(
        "scenes_empty_final_caption_zh.jsonl",
        captionRow("clips/1.mp4"),
        "empty-export/scenes_empty_final_caption_zh.jsonl",
        "application/x-ndjson",
      ),
      projectFile("1.mp4", "video", "empty-export/clips/1.mp4", "video/mp4"),
    ] as unknown as FileList;
    const project = await storage.openFiles(files);
    const createObjectUrl = vi.spyOn(URL, "createObjectURL");

    try {
      await expect(storage.exportProject(project, "A023")).rejects.toThrow("当前没有已完成的任务可导出");
      expect(createObjectUrl).not.toHaveBeenCalled();
    } finally {
      createObjectUrl.mockRestore();
    }
  });
});
