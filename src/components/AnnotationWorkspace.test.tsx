import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { parseVideoDocument } from "../domain/annotation";
import type { ProjectTask } from "../domain/types";
import { captionFixture } from "../test/caption-fixture";
import { AnnotationWorkspace } from "./AnnotationWorkspace";

const task: ProjectTask = {
  id: "sample",
  jsonPath: "/sample.json",
  videoPath: "/sample.mp4",
  videoUrl: "blob:sample",
  sourceSha256: "hash",
  status: "not_started",
  records: {},
  drafts: {},
  videoPosition: 0,
  document: parseVideoDocument(JSON.stringify(captionFixture)),
};

function renderWorkspace(overrides: Partial<ProjectTask> = {}, onCommit = vi.fn(), onDraft = vi.fn()) {
  render(
    <AnnotationWorkspace
      task={{ ...task, ...overrides }}
      onBack={vi.fn()}
      onCommit={onCommit}
      onDraft={onDraft}
      onVideoPosition={vi.fn()}
    />,
  );
  return { onCommit, onDraft };
}

describe("AnnotationWorkspace", () => {
  it("renders three themes and Chinese directly below the English source", () => {
    renderWorkspace();

    expect(screen.getByRole("tab", { name: /Overview/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Storyline/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Speech Transcript/ })).toBeInTheDocument();
    expect(screen.queryByText(/Visible Text/)).not.toBeInTheDocument();
    const english = screen.getByText("Cinematic natural light.");
    const chinese = screen.getByText("电影化的自然光。");
    expect(english.compareDocumentPosition(chinese) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("Other：人物或事件本身存在严重错误，无需修改文本。")).not.toBeInTheDocument();
  });

  it("shows distinct shortcut guidance in the video-side empty area", () => {
    renderWorkspace();

    const guide = screen.getByRole("region", { name: "快捷键说明" });
    expect(guide).toHaveTextContent("TTrue");
    expect(guide).toHaveTextContent("FFalse");
    expect(guide).toHaveTextContent("OOther");
    expect(guide).toHaveTextContent("Ctrl / Cmd + Enter保存 False 修订");
    expect(guide).toHaveTextContent("Space播放 / 暂停");
  });

  it("uses T, F, O and Ctrl/Cmd+Enter as non-conflicting shortcuts", () => {
    const { onCommit } = renderWorkspace();

    fireEvent.keyDown(window, { key: "t" });
    expect(onCommit).toHaveBeenCalledWith(
      "overview.overall_visual_style",
      "true",
      { overall_visual_style: "Cinematic natural light." },
    );

    fireEvent.keyDown(window, { key: "f" });
    const editor = screen.getByLabelText("修订 overall_audio_style");
    fireEvent.change(editor, { target: { value: "Corrected audio style." } });
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    expect(onCommit).toHaveBeenCalledWith(
      "overview.overall_audio_style",
      "false",
      { overall_audio_style: "Corrected audio style." },
    );

    fireEvent.keyDown(window, { key: "o" });
    expect(onCommit).toHaveBeenCalledWith(
      "overview.character_profiles.0",
      "other",
      { profile: "Alice - A calm woman." },
    );
  });

  it("opens an English-only editor for False and requires a changed field", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderWorkspace();

    await user.click(screen.getAllByRole("button", { name: "False" })[0]!);
    const save = screen.getByRole("button", { name: "保存修订" });
    expect(save).toBeDisabled();
    expect(screen.queryByDisplayValue("电影化的自然光。")).not.toBeInTheDocument();

    const editor = screen.getByLabelText("修订 overall_visual_style");
    await user.clear(editor);
    await user.type(editor, "Fixed visual style.");
    expect(save).toBeEnabled();
    await user.click(save);

    expect(onCommit).toHaveBeenCalledWith(
      "overview.overall_visual_style",
      "false",
      { overall_visual_style: "Fixed visual style." },
    );
  });

  it("commits Other immediately without opening an editor", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderWorkspace();

    await user.click(screen.getAllByRole("button", { name: "Other" })[0]!);

    expect(onCommit).toHaveBeenCalledWith(
      "overview.overall_visual_style",
      "other",
      { overall_visual_style: "Cinematic natural light." },
    );
    expect(screen.queryByRole("button", { name: "保存修订" })).not.toBeInTheDocument();
  });

  it("shows the Other explanation only while its control is hovered or focused", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    const other = screen.getAllByRole("button", { name: "Other" })[0]!;

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.hover(other);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Other：人物或事件本身存在严重错误，无需修改文本。");
    expect(other).toHaveAttribute("aria-describedby", screen.getByRole("tooltip").id);
    await user.unhover(other);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.focus(other);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.blur(other);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(other).not.toHaveAttribute("title");
  });

  it("shows only False as selected while replacing a saved True with a draft", async () => {
    const user = userEvent.setup();
    const { onDraft } = renderWorkspace({
      records: {
        "overview.overall_visual_style": {
          unitId: "overview.overall_visual_style",
          decision: "true",
          correctedFields: {},
          updatedAt: "2026-07-14T00:00:00.000Z",
        },
      },
    });

    const falseButton = screen.getAllByRole("button", { name: "False" })[0]!;
    await user.click(falseButton);

    expect(falseButton).toHaveClass("selected");
    expect(screen.getAllByRole("button", { name: "True" })[0]).not.toHaveClass("selected");
    expect(onDraft).toHaveBeenCalledWith(
      "overview.overall_visual_style",
      "false",
      { overall_visual_style: "Cinematic natural light." },
    );
  });

  it("cancels segment end enforcement when the user seeks freely", async () => {
    const user = userEvent.setup();
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    renderWorkspace();
    await user.click(screen.getByRole("tab", { name: /Storyline/ }));
    await user.click(screen.getAllByRole("button", { name: /播放 Storyline/ })[0]!);
    const video = document.querySelector("video")!;

    fireEvent.seeked(video);
    fireEvent.seeking(video);
    Object.defineProperty(video, "currentTime", { configurable: true, value: 6 });
    fireEvent.timeUpdate(video);

    expect(pause).not.toHaveBeenCalled();
  });

  it("renders an always-visible timeline and dragging it seeks freely", async () => {
    const user = userEvent.setup();
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const onVideoPosition = vi.fn();
    render(
      <AnnotationWorkspace
        task={task}
        onBack={vi.fn()}
        onCommit={vi.fn()}
        onDraft={vi.fn()}
        onVideoPosition={onVideoPosition}
      />,
    );
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "duration", { configurable: true, value: 10 });
    fireEvent.loadedMetadata(video);

    const timeline = screen.getByRole("slider", { name: "视频进度" });
    expect(timeline).toBeEnabled();
    expect(timeline).toHaveAttribute("max", "10");

    await user.click(screen.getByRole("tab", { name: /Storyline/ }));
    await user.click(screen.getAllByRole("button", { name: /播放 Storyline/ })[0]!);
    fireEvent.change(timeline, { target: { value: "4.25" } });
    expect(video.currentTime).toBe(4.25);
    expect(onVideoPosition).toHaveBeenCalledWith(4.25);

    Object.defineProperty(video, "currentTime", { configurable: true, value: 6 });
    fireEvent.timeUpdate(video);
    expect(pause).not.toHaveBeenCalled();
    expect(screen.getByText("00:06.00 / 00:10.00")).toBeInTheDocument();
  });
});
