import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { isTauri } from "@tauri-apps/api/core";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseVideoDocument } from "../domain/annotation";
import type { ProjectTask } from "../domain/types";
import type { MpvClient, MpvPlaybackState } from "../media/mpv-client";
import { captionFixture } from "../test/caption-fixture";
import { AnnotationWorkspace } from "./AnnotationWorkspace";

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, isTauri: vi.fn(() => false) };
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockResolvedValue(() => undefined),
    setFullscreen: vi.fn().mockResolvedValue(undefined),
  }),
}));

afterEach(() => {
  vi.mocked(isTauri).mockReturnValue(false);
});

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

  it("replays the complete system-player video and removes card-level replay controls", async () => {
    const user = userEvent.setup();
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    renderWorkspace();
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    const video = document.querySelector("video")!;
    expect(screen.getByRole("button", { name: "重播视频" })).toBeDisabled();
    Object.defineProperty(video, "duration", { configurable: true, value: 10 });
    fireEvent.loadedMetadata(video);

    const replay = screen.getByRole("button", { name: "重播视频" });
    expect(replay).toBeEnabled();
    await user.click(screen.getByRole("tab", { name: /Storyline/ }));
    expect(screen.queryByRole("button", { name: /播放 Storyline/ })).not.toBeInTheDocument();
    await user.click(document.getElementById("unit-card-storyline.1")!);
    expect(video.currentTime).toBe(5);
    expect(play).not.toHaveBeenCalled();

    await user.click(replay);
    expect(video.currentTime).toBe(0);
    expect(play).toHaveBeenCalledTimes(1);

    Object.defineProperty(video, "currentTime", { configurable: true, value: 6 });
    fireEvent.timeUpdate(video);
    expect(pause).not.toHaveBeenCalled();
  });

  it("renders an always-visible timeline and dragging it seeks freely", async () => {
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
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "duration", { configurable: true, value: 10 });
    fireEvent.loadedMetadata(video);

    const timeline = screen.getByRole("slider", { name: "视频进度" });
    expect(timeline).toBeEnabled();
    expect(timeline).toHaveAttribute("max", "10");

    fireEvent.change(timeline, { target: { value: "4.25" } });
    expect(video.currentTime).toBe(4.25);
    expect(onVideoPosition).toHaveBeenCalledWith(4.25);

    Object.defineProperty(video, "currentTime", { configurable: true, value: 6 });
    fireEvent.timeUpdate(video);
    expect(pause).not.toHaveBeenCalled();
    expect(screen.getByText("00:06.00 / 00:10.00")).toBeInTheDocument();
  });

  it("uses the native mpv backend with complete custom controls when available", async () => {
    const user = userEvent.setup();
    const state: MpvPlaybackState = {
      ready: true,
      duration: 12,
      currentTime: 2.5,
      paused: true,
      volume: 80,
      muted: false,
      ended: false,
    };
    const mpv: MpvClient = {
      probe: vi.fn().mockResolvedValue({ available: true }),
      create: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue(undefined),
      setBounds: vi.fn().mockResolvedValue(undefined),
      state: vi.fn().mockResolvedValue(state),
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn().mockResolvedValue(undefined),
      seek: vi.fn().mockResolvedValue(undefined),
      setVolume: vi.fn().mockResolvedValue(undefined),
      setMuted: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };

    render(
      <AnnotationWorkspace
        task={task}
        mpvClient={mpv}
        annotationFontSize={14}
        onBack={vi.fn()}
        onCommit={vi.fn()}
        onDraft={vi.fn()}
        onVideoPosition={vi.fn()}
        onAnnotationFontSizeChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(mpv.load).toHaveBeenCalledWith(task.videoPath, 0));
    expect(document.querySelector("video")).not.toBeInTheDocument();
    expect(screen.getByTestId("mpv-video-surface")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "播放视频" }));
    expect(mpv.play).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "静音" }));
    expect(mpv.setMuted).toHaveBeenCalledWith(true);
    fireEvent.change(screen.getByRole("slider", { name: "音量" }), { target: { value: "45" } });
    expect(mpv.setVolume).toHaveBeenCalledWith(45);
    fireEvent.change(screen.getByRole("slider", { name: "视频进度" }), { target: { value: "6.25" } });
    expect(mpv.seek).toHaveBeenCalledWith(6.25);
    expect(screen.getByRole("button", { name: "进入全屏" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重播视频" }));
    expect(mpv.seek).toHaveBeenLastCalledWith(0);
    expect(mpv.play).toHaveBeenCalled();
  });

  it("does not synchronize native mpv bounds when the annotation list scrolls", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const mpv: MpvClient = {
      probe: vi.fn().mockResolvedValue({ available: true }),
      create: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue(undefined),
      setBounds: vi.fn().mockResolvedValue(undefined),
      state: vi.fn().mockResolvedValue({
        ready: true,
        duration: 12,
        currentTime: 0,
        paused: true,
        volume: 100,
        muted: false,
        ended: false,
      }),
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      setVolume: vi.fn(),
      setMuted: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
    };

    const { container } = render(
      <AnnotationWorkspace
        task={task}
        mpvClient={mpv}
        annotationFontSize={14}
        onBack={vi.fn()}
        onCommit={vi.fn()}
        onDraft={vi.fn()}
        onVideoPosition={vi.fn()}
        onAnnotationFontSizeChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(mpv.load).toHaveBeenCalled());
    await waitFor(() => expect(mpv.setBounds).toHaveBeenCalled());
    const callsBeforeScroll = vi.mocked(mpv.setBounds).mock.calls.length;
    fireEvent.scroll(container.querySelector(".unit-list")!);
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    expect(mpv.setBounds).toHaveBeenCalledTimes(callsBeforeScroll);

    const surface = screen.getByTestId("mpv-video-surface");
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      x: 12,
      y: 24,
      width: 640,
      height: 360,
      top: 24,
      right: 652,
      bottom: 384,
      left: 12,
      toJSON: () => ({}),
    });
    fireEvent(window, new Event("resize"));
    fireEvent(window, new Event("resize"));
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    expect(mpv.setBounds).toHaveBeenCalledTimes(callsBeforeScroll + 1);
    expect(mpv.setBounds).toHaveBeenLastCalledWith({ x: 12, y: 24, width: 640, height: 360 });

    fireEvent(window, new Event("resize"));
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    expect(mpv.setBounds).toHaveBeenCalledTimes(callsBeforeScroll + 1);
  });

  it("falls back to the system video player with a retry action when mpv initialization fails", async () => {
    const mpv: MpvClient = {
      probe: vi.fn().mockResolvedValue({ available: true }),
      create: vi.fn().mockRejectedValue(new Error("libmpv could not be loaded")),
      load: vi.fn(),
      setBounds: vi.fn(),
      state: vi.fn(),
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      setVolume: vi.fn(),
      setMuted: vi.fn(),
      destroy: vi.fn(),
    };

    render(
      <AnnotationWorkspace
        task={task}
        mpvClient={mpv}
        annotationFontSize={14}
        onBack={vi.fn()}
        onCommit={vi.fn()}
        onDraft={vi.fn()}
        onVideoPosition={vi.fn()}
        onAnnotationFontSizeChange={vi.fn()}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("libmpv could not be loaded");
    expect(document.querySelector("video")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试 libmpv" })).toBeInTheDocument();
  });

  it("falls back when the native renderer reports an asynchronous playback error", async () => {
    const mpv: MpvClient = {
      probe: vi.fn().mockResolvedValue({ available: true }),
      create: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue(undefined),
      setBounds: vi.fn().mockResolvedValue(undefined),
      state: vi.fn().mockResolvedValue({
        ready: true,
        duration: 12,
        currentTime: 0,
        paused: true,
        volume: 100,
        muted: false,
        ended: false,
        error: "视频渲染失败",
      }),
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      setVolume: vi.fn(),
      setMuted: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
    };

    render(
      <AnnotationWorkspace
        task={task}
        mpvClient={mpv}
        annotationFontSize={14}
        onBack={vi.fn()}
        onCommit={vi.fn()}
        onDraft={vi.fn()}
        onVideoPosition={vi.fn()}
        onAnnotationFontSizeChange={vi.fn()}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("视频渲染失败");
    expect(document.querySelector("video")).toBeInTheDocument();
    expect(mpv.destroy).toHaveBeenCalled();
  });
});
