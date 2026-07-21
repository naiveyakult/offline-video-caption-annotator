import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { captionFixture } from "../test/caption-fixture";
import type { ProjectSnapshot } from "../domain/types";
import { ProjectDashboard } from "./ProjectDashboard";

describe("ProjectDashboard media anomalies", () => {
  it("shows audio scan progress while a project is opening", () => {
    render(
      <ProjectDashboard
        annotatorId="A023"
        loading
        scanProgress={{ current: 37, total: 1000, cacheHits: 30 }}
        onOpenProject={vi.fn()}
        onOpenTask={vi.fn()}
        onExport={vi.fn()}
        onSettings={vi.fn()}
      />,
    );

    expect(screen.getByText("正在检测音轨 37/1000")).toBeInTheDocument();
  });

  it("shows the multi-track reason and disables annotation", () => {
    const project: ProjectSnapshot = {
      rootPath: "/synthetic/project",
      name: "synthetic",
      activeTheme: "overview",
      updatedAt: "2026-07-21T00:00:00.000Z",
      tasks: [{
        id: "multi",
        jsonPath: "/synthetic/project/scenes_batch_final_caption_zh.jsonl",
        videoPath: "/synthetic/project/clips/multi.mp4",
        videoUrl: "asset://multi.mp4",
        sourceSha256: "hash",
        document: captionFixture,
        mediaAnomaly: {
          code: "multiple_audio_tracks",
          message: "多音轨视频（检测到 2 条音频轨道）",
          audioTrackCount: 2,
        },
        status: "invalid",
        records: {},
        drafts: {},
        videoPosition: 0,
      }],
    };

    render(
      <ProjectDashboard
        project={project}
        annotatorId="A023"
        loading={false}
        onOpenProject={vi.fn()}
        onOpenTask={vi.fn()}
        onExport={vi.fn()}
        onSettings={vi.fn()}
      />,
    );

    expect(screen.getByText("多音轨视频（检测到 2 条音频轨道）")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续标注" })).toBeDisabled();
  });
});
