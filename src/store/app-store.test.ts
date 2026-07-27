import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseVideoDocument } from "../domain/annotation";
import type { ProjectSnapshot } from "../domain/types";
import { captionFixture } from "../test/caption-fixture";

const FONT_SIZE_KEY = "video-annotator:annotation-font-size";

async function loadStore() {
  vi.resetModules();
  return (await import("./app-store")).useAppStore;
}

describe("annotation font-size preference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to 14px and persists a valid selection", async () => {
    const useAppStore = await loadStore();

    expect(useAppStore.getState().annotationFontSize).toBe(14);
    useAppStore.getState().setAnnotationFontSize(16);

    expect(useAppStore.getState().annotationFontSize).toBe(16);
    expect(localStorage.getItem(FONT_SIZE_KEY)).toBe("16");
  });

  it("restores valid values and falls back from invalid cached values", async () => {
    localStorage.setItem(FONT_SIZE_KEY, "12");
    let useAppStore = await loadStore();
    expect(useAppStore.getState().annotationFontSize).toBe(12);

    localStorage.setItem(FONT_SIZE_KEY, "99");
    useAppStore = await loadStore();
    expect(useAppStore.getState().annotationFontSize).toBe(14);
  });

  it("stores an explicit task-level early-stop label when False is committed", async () => {
    const useAppStore = await loadStore();
    const project: ProjectSnapshot = {
      rootPath: "/project",
      name: "project",
      activeTaskId: "task-1",
      activeTheme: "overview",
      updatedAt: "2026-07-27T00:00:00.000Z",
      tasks: [{
        id: "task-1",
        jsonPath: "/project/scenes_batch_final_caption_zh.jsonl",
        videoPath: "/project/clips/task-1.mp4",
        videoUrl: "blob:task-1",
        sourceSha256: "hash",
        document: parseVideoDocument(JSON.stringify(captionFixture)),
        status: "not_started",
        records: {},
        drafts: {},
        videoPosition: 0,
      }],
    };
    useAppStore.getState().setProject(project);

    useAppStore.getState().commit(
      "overview.overall_visual_style",
      "false",
      { overall_visual_style: "Cinematic natural light." },
    );

    expect(useAppStore.getState().project?.tasks[0]).toMatchObject({
      status: "complete",
      videoDecision: "false",
      completionMode: "false_early_stop",
      stoppedAtUnitId: "overview.overall_visual_style",
    });
  });
});
