import { fireEvent, render, screen, within } from "@testing-library/react";
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

function renderWorkspace(
  overrides: Partial<ProjectTask> = {},
  onCommit = vi.fn(),
  onDraft = vi.fn(),
  annotationFontSize: 12 | 14 | 16 = 14,
  onAnnotationFontSizeChange = vi.fn(),
  onUnitChange = vi.fn(),
) {
  render(
    <AnnotationWorkspace
      task={{ ...task, ...overrides }}
      annotationFontSize={annotationFontSize}
      onBack={vi.fn()}
      onCommit={onCommit}
      onDraft={onDraft}
      onVideoPosition={vi.fn()}
      onUnitChange={onUnitChange}
      onAnnotationFontSizeChange={onAnnotationFontSizeChange}
    />,
  );
  return { onCommit, onDraft, onAnnotationFontSizeChange, onUnitChange };
}

describe("AnnotationWorkspace", () => {
  it("renders three themes and Chinese directly below the English source", () => {
    renderWorkspace();

    expect(screen.getByRole("tab", { name: /Overview/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Storyline/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Speech Transcript/ })).toBeInTheDocument();
    expect(screen.queryByText(/Visible Text/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Question" })).toHaveLength(5);
    const english = screen.getByText("Cinematic natural light.");
    const chinese = screen.getByText("电影化的自然光。");
    expect(english.compareDocumentPosition(chinese) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("Other：人物或事件本身存在严重错误，无需修改文本。")).not.toBeInTheDocument();
  });

  it("removes shortcut hints while keeping font controls in the workspace header", () => {
    renderWorkspace();

    expect(screen.queryByRole("region", { name: "快捷键说明" })).not.toBeInTheDocument();
    expect(screen.queryByText("⌘S / Ctrl+S")).not.toBeInTheDocument();
    expect(screen.queryByText("Space")).not.toBeInTheDocument();

    const fontGroup = screen.getByRole("group", { name: "标注字号" });
    expect(within(fontGroup).getByRole("button", { name: "小号 12px" })).toHaveAttribute("aria-pressed", "false");
    expect(within(fontGroup).getByRole("button", { name: "标准 14px" })).toHaveAttribute("aria-pressed", "true");
    expect(within(fontGroup).getByRole("button", { name: "大号 16px" })).toHaveAttribute("aria-pressed", "false");
  });

  it("does not trigger decisions or video playback from keyboard shortcuts", () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const { onCommit } = renderWorkspace();

    fireEvent.keyDown(window, { key: "1" });
    fireEvent.keyDown(window, { key: "2" });
    fireEvent.keyDown(window, { key: "3" });
    fireEvent.keyDown(window, { key: " ", code: "Space" });

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "保存修订" })).not.toBeInTheDocument();
    expect(play).not.toHaveBeenCalled();
  });

  it.each([
    ["Ctrl+S", { ctrlKey: true }],
    ["Command+S", { metaKey: true }],
  ])("does not save a changed False editor with %s", async (_label, modifier) => {
    const user = userEvent.setup();
    const { onCommit } = renderWorkspace();
    await user.click(screen.getAllByRole("button", { name: "False" })[0]!);
    const editor = screen.getByLabelText("修订 overall_visual_style");
    fireEvent.change(editor, { target: { value: "Corrected style." } });

    fireEvent.keyDown(editor, { key: "s", ...modifier });

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("修订 overall_visual_style")).toBeInTheDocument();
  });

  it("keeps former shortcut keys as normal input while an editor is focused", async () => {
    const user = userEvent.setup();
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const { onCommit } = renderWorkspace();
    await user.click(screen.getAllByRole("button", { name: "False" })[0]!);
    const editor = screen.getByLabelText("修订 overall_visual_style");
    await user.click(editor);
    await user.type(editor, "s123 ");

    expect(editor).toHaveValue("Cinematic natural light.s123 ");
    expect(onCommit).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });

  it("applies and changes only the controlled annotation font size", async () => {
    const user = userEvent.setup();
    const onFontSizeChange = vi.fn();
    const { onAnnotationFontSizeChange } = renderWorkspace({}, vi.fn(), vi.fn(), 14, onFontSizeChange);
    const workspace = screen.getByRole("main");

    expect(workspace.style.getPropertyValue("--annotation-font-size")).toBe("14px");
    await user.click(screen.getByRole("button", { name: "大号 16px" }));
    expect(onAnnotationFontSizeChange).toHaveBeenCalledWith(16);
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

  it("commits Question immediately with source text and advances without opening an editor", async () => {
    const user = userEvent.setup();
    const { onCommit, onUnitChange } = renderWorkspace();

    await user.click(screen.getAllByRole("button", { name: "Question" })[0]!);

    expect(onCommit).toHaveBeenCalledWith(
      "overview.overall_visual_style",
      "question",
      { overall_visual_style: "Cinematic natural light." },
    );
    expect(screen.queryByRole("button", { name: "保存修订" })).not.toBeInTheDocument();
    expect(onUnitChange).toHaveBeenLastCalledWith("overview.overall_audio_style");
  });

  it("offers Question in Overview, Storyline and Speech Transcript", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    expect(screen.getAllByRole("button", { name: "Question" })).toHaveLength(5);
    await user.click(screen.getByRole("tab", { name: /Storyline/ }));
    expect(screen.getAllByRole("button", { name: "Question" })).toHaveLength(2);
    await user.click(screen.getByRole("tab", { name: /Speech Transcript/ }));
    expect(screen.getAllByRole("button", { name: "Question" })).toHaveLength(2);
  });

  it("shows the Question explanation only while its control is hovered or focused", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    const question = screen.getAllByRole("button", { name: "Question" })[0]!;
    const explanation = "Question：事件匹配不准确，但受当前分段、说话人或时间范围限制，无法合理修订；问题不属于严重错误。";

    expect(screen.queryByText(explanation)).not.toBeInTheDocument();
    await user.hover(question);
    expect(screen.getByRole("tooltip")).toHaveTextContent(explanation);
    expect(question).toHaveAttribute("aria-describedby", screen.getByRole("tooltip").id);
    await user.unhover(question);
    expect(screen.queryByText(explanation)).not.toBeInTheDocument();

    fireEvent.focus(question);
    expect(screen.getByRole("tooltip")).toHaveTextContent(explanation);
    fireEvent.blur(question);
    expect(screen.queryByText(explanation)).not.toBeInTheDocument();
    expect(question).not.toHaveAttribute("title");
  });

  it("replaces a False draft with Question and restores the source text", async () => {
    const user = userEvent.setup();
    const { onCommit, onUnitChange } = renderWorkspace({
      drafts: {
        "overview.overall_visual_style": {
          unitId: "overview.overall_visual_style",
          decision: "false",
          fields: { overall_visual_style: "Unfinished correction." },
          updatedAt: "2026-07-14T00:00:00.000Z",
        },
      },
    });

    expect(screen.getByLabelText("修订 overall_visual_style")).toHaveValue("Unfinished correction.");
    await user.click(screen.getAllByRole("button", { name: "Question" })[0]!);

    expect(onCommit).toHaveBeenCalledWith(
      "overview.overall_visual_style",
      "question",
      { overall_visual_style: "Cinematic natural light." },
    );
    expect(screen.queryByLabelText("修订 overall_visual_style")).not.toBeInTheDocument();
    expect(onUnitChange).toHaveBeenLastCalledWith("overview.overall_audio_style");
  });

  it("replaces a saved False correction with Question and restores the source text", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderWorkspace({
      records: {
        "overview.overall_visual_style": {
          unitId: "overview.overall_visual_style",
          decision: "false",
          correctedFields: { overall_visual_style: "Saved correction." },
          updatedAt: "2026-07-14T00:00:00.000Z",
        },
      },
    });

    await user.click(screen.getAllByRole("button", { name: "Question" })[0]!);
    expect(onCommit).toHaveBeenCalledWith(
      "overview.overall_visual_style",
      "question",
      { overall_visual_style: "Cinematic natural light." },
    );
    expect(screen.queryByLabelText("修订 overall_visual_style")).not.toBeInTheDocument();
  });

  it("shows exactly one selected decision when Question is saved", () => {
    renderWorkspace({
      records: {
        "overview.overall_visual_style": {
          unitId: "overview.overall_visual_style",
          decision: "question",
          correctedFields: {},
          updatedAt: "2026-07-14T00:00:00.000Z",
        },
      },
    });

    const buttons = ["True", "False", "Question", "Other"].map(
      (name) => screen.getAllByRole("button", { name })[0]!,
    );
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["false", "false", "true", "false"]);
    expect(screen.getByText("Question", { selector: ".status-badge" })).toBeInTheDocument();
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
    expect(falseButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("button", { name: "True" })[0]).not.toHaveClass("selected");
    expect(screen.getAllByRole("button", { name: "True" })[0]).toHaveAttribute("aria-pressed", "false");
    expect(screen.getAllByRole("button", { name: "Question" })[0]).toHaveAttribute("aria-pressed", "false");
    expect(screen.getAllByRole("button", { name: "Other" })[0]).toHaveAttribute("aria-pressed", "false");
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
        annotationFontSize={14}
        onBack={vi.fn()}
        onCommit={vi.fn()}
        onDraft={vi.fn()}
        onVideoPosition={onVideoPosition}
        onAnnotationFontSizeChange={vi.fn()}
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
