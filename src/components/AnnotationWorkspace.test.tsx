import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { parseVideoDocument } from "../domain/annotation";
import type { ProjectTask } from "../domain/types";
import { captionFixture } from "../test/caption-fixture";
import { AnnotationWorkspace } from "./AnnotationWorkspace";

const task: ProjectTask = {
  id: "sample",
  jsonPath: "/sample.jsonl",
  videoPath: "/sample.mp4",
  videoUrl: "blob:sample",
  sourceSha256: "hash",
  status: "not_started",
  records: {},
  drafts: {},
  videoPosition: 0,
  document: parseVideoDocument(JSON.stringify(captionFixture)),
};

function renderWorkspace(
  overrides: Partial<ProjectTask> = {},
  props: Partial<React.ComponentProps<typeof AnnotationWorkspace>> = {},
) {
  const callbacks = {
    onBack: vi.fn(),
    onCommit: vi.fn(),
    onVideoPosition: vi.fn(),
    onUnitChange: vi.fn(),
    onAnnotationFontSizeChange: vi.fn(),
  };
  render(
    <AnnotationWorkspace
      task={{ ...task, ...overrides }}
      annotationFontSize={14}
      {...callbacks}
      {...props}
    />,
  );
  return { ...callbacks, ...props };
}

describe("AnnotationWorkspace", () => {
  it("offers only True and False without a correction editor", () => {
    renderWorkspace();

    expect(screen.getAllByRole("button", { name: "True" })).toHaveLength(5);
    expect(screen.getAllByRole("button", { name: "False" })).toHaveLength(5);
    expect(screen.queryByRole("button", { name: "Question" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Other" })).not.toBeInTheDocument();
    expect(screen.queryByText("修订英文内容")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存修订" })).not.toBeInTheDocument();
  });

  it("keeps True behavior and advances to the next unit", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const onUnitChange = vi.fn();
    renderWorkspace({}, { onCommit, onUnitChange });

    await user.click(screen.getAllByRole("button", { name: "True" })[0]!);

    expect(onCommit).toHaveBeenCalledWith(
      "overview.overall_visual_style",
      "true",
      { overall_visual_style: "Cinematic natural light." },
    );
    expect(onUnitChange).toHaveBeenLastCalledWith("overview.overall_audio_style");
  });

  it("commits False with source fields and immediately opens the next video", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const onNextTask = vi.fn();
    const onUnitChange = vi.fn();
    renderWorkspace({}, { onCommit, onNextTask, onUnitChange });

    await user.click(screen.getAllByRole("button", { name: "False" })[0]!);

    expect(onCommit).toHaveBeenCalledWith(
      "overview.overall_visual_style",
      "false",
      { overall_visual_style: "Cinematic natural light." },
    );
    expect(onNextTask).toHaveBeenCalledOnce();
    expect(onUnitChange).not.toHaveBeenLastCalledWith("overview.overall_audio_style");
  });

  it("returns to the dashboard when False is selected on the last video", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    renderWorkspace({}, { onBack });

    await user.click(screen.getAllByRole("button", { name: "False" })[0]!);

    expect(onBack).toHaveBeenCalledOnce();
  });

  it("renders three themes and Chinese directly below English", () => {
    renderWorkspace();

    expect(screen.getByRole("tab", { name: /Overview/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Storyline/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Speech Transcript/ })).toBeInTheDocument();
    expect(screen.queryByText(/Visible Text/)).not.toBeInTheDocument();
    const english = screen.getByText("Cinematic natural light.");
    const chinese = screen.getByText("电影化的自然光。");
    expect(english.compareDocumentPosition(chinese) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps font controls and has no custom shortcut behavior", () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const onCommit = vi.fn();
    renderWorkspace({}, { onCommit });

    fireEvent.keyDown(window, { key: "1" });
    fireEvent.keyDown(window, { key: "2" });
    fireEvent.keyDown(window, { key: " ", code: "Space" });

    expect(onCommit).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    const fontGroup = screen.getByRole("group", { name: "标注字号" });
    expect(within(fontGroup).getByRole("button", { name: "标准 14px" })).toHaveAttribute("aria-pressed", "true");
  });

  it("changes only the controlled annotation font size", async () => {
    const user = userEvent.setup();
    const onAnnotationFontSizeChange = vi.fn();
    renderWorkspace({}, { onAnnotationFontSizeChange });

    expect(screen.getByRole("main").style.getPropertyValue("--annotation-font-size")).toBe("14px");
    await user.click(screen.getByRole("button", { name: "大号 16px" }));
    expect(onAnnotationFontSizeChange).toHaveBeenCalledWith(16);
  });

  it("keeps the always-visible freely draggable video timeline", async () => {
    const user = userEvent.setup();
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const onVideoPosition = vi.fn();
    renderWorkspace({}, { onVideoPosition });
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "duration", { configurable: true, value: 10 });
    fireEvent.loadedMetadata(video);

    const timeline = screen.getByRole("slider", { name: "视频进度" });
    expect(timeline).toBeEnabled();
    await user.click(screen.getByRole("tab", { name: /Storyline/ }));
    await user.click(screen.getAllByRole("button", { name: /播放 Storyline/ })[0]!);
    fireEvent.change(timeline, { target: { value: "4.25" } });

    expect(video.currentTime).toBe(4.25);
    expect(onVideoPosition).toHaveBeenCalledWith(4.25);
    Object.defineProperty(video, "currentTime", { configurable: true, value: 6 });
    fireEvent.timeUpdate(video);
    expect(pause).not.toHaveBeenCalled();
  });
});
