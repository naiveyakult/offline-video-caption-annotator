import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Check,
  CircleAlert,
  CircleHelp,
  Download,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  Save,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import { buildAnnotationUnits, timeToSeconds, validateCorrection } from "../domain/annotation";
import type {
  AnnotationFontSize,
  AnnotationUnit,
  Decision,
  ProjectTask,
  Theme,
} from "../domain/types";
import {
  elementBounds,
  nativeMpvClient,
  type MpvClient,
  type MpvPlaybackState,
} from "../media/mpv-client";

const THEME_LABELS: Record<Theme, string> = {
  overview: "Overview",
  storyline: "Storyline",
  speech_transcript: "Speech Transcript",
};

const FIELD_LABELS: Record<string, { english: string; chinese: string }> = {
  overall_visual_style: { english: "Overall Visual Style", chinese: "整体视觉风格" },
  overall_audio_style: { english: "Overall Audio Style", chinese: "整体音频风格" },
  profile: { english: "Character Profile", chinese: "人物档案" },
  narrative_theme: { english: "Narrative Theme", chinese: "叙事主题" },
  description: { english: "Description", chinese: "中文参考" },
  speaker: { english: "Speaker", chinese: "说话人" },
  state: { english: "State", chinese: "状态" },
  content: { english: "Content", chinese: "内容" },
};

function formatVideoTime(seconds: number) {
  const safe = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(2).padStart(5, "0")}`;
}

interface AnnotationWorkspaceProps {
  task: ProjectTask;
  mpvClient?: MpvClient;
  annotationFontSize: AnnotationFontSize;
  initialTheme?: Theme;
  initialUnitId?: string;
  onBack: () => void;
  onPreviousTask?: () => void;
  onNextTask?: () => void;
  onExport?: () => void;
  onCommit: (
    unitId: string,
    decision: Exclude<Decision, "pending">,
    fields: Record<string, string>,
  ) => void;
  onDraft: (unitId: string, decision: "false", fields: Record<string, string>) => void;
  onVideoPosition: (position: number) => void;
  onThemeChange?: (theme: Theme) => void;
  onUnitChange?: (unitId: string) => void;
  onAnnotationFontSizeChange: (value: AnnotationFontSize) => void;
}

export function AnnotationWorkspace({
  task,
  mpvClient = nativeMpvClient,
  annotationFontSize,
  initialTheme = "overview",
  initialUnitId,
  onBack,
  onPreviousTask,
  onNextTask,
  onExport,
  onCommit,
  onDraft,
  onVideoPosition,
  onThemeChange,
  onUnitChange,
  onAnnotationFontSizeChange,
}: AnnotationWorkspaceProps) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [activeUnitId, setActiveUnitId] = useState<string>();
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [mpvMode, setMpvMode] = useState<"probing" | "starting" | "active" | "fallback">("probing");
  const [mpvError, setMpvError] = useState<string>();
  const [mpvState, setMpvState] = useState<MpvPlaybackState>({
    ready: false,
    duration: 0,
    currentTime: 0,
    paused: true,
    volume: 100,
    muted: false,
    ended: false,
  });
  const [mpvAttempt, setMpvAttempt] = useState(0);
  const [videoFocus, setVideoFocus] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mpvSurfaceRef = useRef<HTMLDivElement>(null);
  const mpvGenerationRef = useRef(0);
  const lastReportedPositionRef = useRef(Number.NaN);
  const lastMpvPausedRef = useRef(true);
  const lastMpvBoundsRef = useRef<ReturnType<typeof elementBounds> | undefined>(undefined);
  const resumePositionRef = useRef(task.videoPosition);

  useEffect(() => {
    const generation = ++mpvGenerationRef.current;
    let disposed = false;
    setMpvError(undefined);
    setMpvMode("probing");

    const initialize = async () => {
      try {
        const capability = await mpvClient.probe();
        if (disposed || generation !== mpvGenerationRef.current) return;
        if (!capability.available) {
          setMpvMode("fallback");
          if (capability.error) setMpvError(capability.error);
          return;
        }
        setMpvMode("starting");
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        if (disposed || generation !== mpvGenerationRef.current) return;
        const surface = mpvSurfaceRef.current;
        if (!surface) throw new Error("libmpv 视频区域未就绪");
        await mpvClient.create(elementBounds(surface));
        if (disposed || generation !== mpvGenerationRef.current) {
          await mpvClient.destroy();
          return;
        }
        await mpvClient.load(task.videoPath, resumePositionRef.current);
        setMpvMode("active");
      } catch (error) {
        if (disposed || generation !== mpvGenerationRef.current) return;
        setMpvError(error instanceof Error ? error.message : String(error));
        setMpvMode("fallback");
        await Promise.resolve(mpvClient.destroy()).catch(() => undefined);
      }
    };
    void initialize();

    return () => {
      disposed = true;
      void Promise.resolve(mpvClient.destroy()).catch(() => undefined);
    };
  }, [mpvClient, mpvAttempt, task.id, task.videoPath]);

  useEffect(() => {
    if (mpvMode !== "active" || !isTauri()) return;
    const surface = mpvSurfaceRef.current;
    if (!surface) return;
    let active = true;
    let animationFrame: number | undefined;
    const syncBounds = () => {
      if (animationFrame !== undefined) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = undefined;
        if (!active) return;
        const bounds = elementBounds(surface);
        const previous = lastMpvBoundsRef.current;
        if (previous
          && previous.x === bounds.x
          && previous.y === bounds.y
          && previous.width === bounds.width
          && previous.height === bounds.height) return;
        lastMpvBoundsRef.current = bounds;
        void mpvClient.setBounds(bounds).catch((error) => {
          if (!active) return;
          setMpvError(error instanceof Error ? error.message : String(error));
          setMpvMode("fallback");
          void Promise.resolve(mpvClient.destroy()).catch(() => undefined);
        });
      });
    };
    syncBounds();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(syncBounds);
    observer?.observe(surface);
    window.addEventListener("resize", syncBounds);
    return () => {
      active = false;
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
      observer?.disconnect();
      window.removeEventListener("resize", syncBounds);
    };
  }, [mpvClient, mpvMode, videoFocus]);

  useEffect(() => {
    if (mpvMode !== "active") return;
    let disposed = false;
    const update = async () => {
      try {
        const state = await mpvClient.state();
        if (disposed) return;
        if (state.error) throw new Error(state.error);
        setMpvState(state);
        setVideoDuration(state.duration);
        setVideoCurrentTime(state.currentTime);
        resumePositionRef.current = state.currentTime;
        const pauseChanged = state.paused !== lastMpvPausedRef.current;
        if (pauseChanged || !Number.isFinite(lastReportedPositionRef.current)
          || Math.abs(state.currentTime - lastReportedPositionRef.current) >= 0.75) {
          lastReportedPositionRef.current = state.currentTime;
          onVideoPosition(state.currentTime);
        }
        lastMpvPausedRef.current = state.paused;
      } catch (error) {
        if (disposed) return;
        setMpvError(error instanceof Error ? error.message : String(error));
        setMpvMode("fallback");
        void Promise.resolve(mpvClient.destroy()).catch(() => undefined);
      }
    };
    void update();
    const timer = window.setInterval(() => void update(), 100);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [mpvClient, mpvMode, onVideoPosition]);

  useEffect(() => {
    if (mpvMode !== "active" || !isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const appWindow = getCurrentWindow();
    void appWindow.onResized(async () => {
      const fullscreen = await appWindow.isFullscreen().catch(() => videoFocus);
      if (!disposed) setVideoFocus(fullscreen);
    }).then((stop) => { unlisten = stop; }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [mpvMode, videoFocus]);

  const units = useMemo(
    () => (task.document ? buildAnnotationUnits(task.document) : []),
    [task.document],
  );
  const visibleUnits = units.filter((unit) => unit.theme === theme);
  const completed = units.filter((unit) => task.records[unit.id]).length;

  useEffect(() => {
    const restored = visibleUnits.find((unit) => unit.id === initialUnitId);
    const next = restored ?? visibleUnits.find((unit) => !task.records[unit.id]) ?? visibleUnits[0];
    setActiveUnitId(next?.id);
    if (next) onUnitChange?.(next.id);
  }, [theme, task.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!activeUnitId) return;
    window.requestAnimationFrame(() => {
      document.getElementById(`unit-card-${activeUnitId}`)?.scrollIntoView?.({ block: "center" });
    });
  }, [activeUnitId]);

  const advanceFrom = (unitId: string) => {
    const index = visibleUnits.findIndex((unit) => unit.id === unitId);
    const next = visibleUnits.slice(index + 1).find((unit) => !task.records[unit.id]);
    if (next) {
      setActiveUnitId(next.id);
      onUnitChange?.(next.id);
    }
  };

  const selectTheme = (nextTheme: Theme) => {
    setTheme(nextTheme);
    onThemeChange?.(nextTheme);
  };

  const selectUnit = (unit: AnnotationUnit) => {
    setActiveUnitId(unit.id);
    onUnitChange?.(unit.id);
    if (!unit.startTime) return;
    const start = timeToSeconds(unit.startTime);
    resumePositionRef.current = start;
    lastReportedPositionRef.current = start;
    setVideoCurrentTime(start);
    onVideoPosition(start);
    if (mpvMode === "active") {
      void mpvClient.seek(start);
      return;
    }
    if (!videoRef.current) return;
    videoRef.current.currentTime = start;
  };

  const seekFreely = (position: number) => {
    const next = Math.max(0, Math.min(position, videoDuration || 0));
    resumePositionRef.current = next;
    if (mpvMode === "active") {
      void mpvClient.seek(next);
      setVideoCurrentTime(next);
      lastReportedPositionRef.current = next;
      onVideoPosition(next);
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = next;
    setVideoCurrentTime(next);
    onVideoPosition(next);
  };

  const replayVideo = () => {
    resumePositionRef.current = 0;
    lastReportedPositionRef.current = 0;
    setVideoCurrentTime(0);
    onVideoPosition(0);
    if (mpvMode === "active") {
      void mpvClient.seek(0).then(() => mpvClient.play());
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = 0;
    void video.play();
  };

  const commitAndAdvance = (
    unitId: string,
    decision: Exclude<Decision, "pending">,
    fields: Record<string, string>,
  ) => {
    onCommit(unitId, decision, fields);
    advanceFrom(unitId);
  };

  return (
    <main
      className={`workspace-shell ${videoFocus ? "video-focus" : ""}`}
      style={{ "--annotation-font-size": `${annotationFontSize}px` } as CSSProperties}
    >
      <header className="workspace-header">
        <button className="icon-button" onClick={onBack} aria-label="返回任务列表"><ArrowLeft size={19} /></button>
        <div className="workspace-title"><span className="eyebrow">正在标注</span><strong>{task.id}</strong></div>
        <div className="task-navigation" aria-label="任务导航">
          <button className="icon-button" onClick={onPreviousTask} disabled={!onPreviousTask} aria-label="上一任务"><ChevronLeft size={18} /></button>
          <button className="icon-button" onClick={onNextTask} disabled={!onNextTask} aria-label="下一任务"><ChevronRight size={18} /></button>
        </div>
        <div className="workspace-toolbar">
          <div className="font-size-control" role="group" aria-label="标注字号">
            <span>字号</span>
            {([
              [12, "A−", "小号 12px"],
              [14, "A", "标准 14px"],
              [16, "A+", "大号 16px"],
            ] as const).map(([value, label, ariaLabel]) => (
              <button
                key={value}
                type="button"
                aria-label={ariaLabel}
                aria-pressed={annotationFontSize === value}
                onClick={() => onAnnotationFontSizeChange(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="header-progress">
          <span>{completed}/{units.length}</span>
          <div className="progress-track"><span style={{ width: `${units.length ? (completed / units.length) * 100 : 0}%` }} /></div>
        </div>
        <span className="save-indicator"><Check size={15} /> 已自动保存</span>
        <button className="secondary-button compact-button" onClick={onExport}><Download size={15} /> 导出</button>
      </header>

      <section className="workspace-grid">
        <aside className="video-pane">
          <div className="video-frame">
            <div
              ref={mpvSurfaceRef}
              data-testid="mpv-video-surface"
              className={`mpv-video-surface ${mpvMode === "active" || mpvMode === "starting" ? "visible" : ""}`}
              aria-label="libmpv 视频画面"
            />
            {mpvMode === "fallback" && <video
              ref={videoRef}
              src={task.videoUrl || undefined}
              controls
              preload="metadata"
              onLoadedMetadata={(event) => {
                const duration = Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0;
                setVideoDuration(duration);
                const restored = Math.min(resumePositionRef.current, duration || 0);
                event.currentTarget.currentTime = restored;
                setVideoCurrentTime(restored);
              }}
              onDurationChange={(event) => setVideoDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
              onTimeUpdate={(event) => {
                const current = event.currentTarget.currentTime;
                setVideoCurrentTime(current);
                resumePositionRef.current = current;
                onVideoPosition(current);
              }}
            />}
            {(mpvMode === "probing" || mpvMode === "starting") && <span className="mpv-loading">libmpv 正在准备视频…</span>}
          </div>
          {mpvError && mpvMode === "fallback" && (
            <div className="mpv-fallback" role="alert">
              <span>libmpv 启动失败，已切换系统播放器：{mpvError}</span>
              <button type="button" onClick={() => setMpvAttempt((value) => value + 1)}>重试 libmpv</button>
            </div>
          )}
          {mpvMode === "active" && (
            <div className="mpv-controls" role="group" aria-label="libmpv 播放控制">
              <button
                type="button"
                aria-label={mpvState.paused ? "播放视频" : "暂停视频"}
                onClick={() => void (mpvState.paused ? mpvClient.play() : mpvClient.pause())}
              >{mpvState.paused ? <Play size={16} /> : <Pause size={16} />}</button>
              <button
                type="button"
                aria-label={mpvState.muted ? "取消静音" : "静音"}
                onClick={() => void mpvClient.setMuted(!mpvState.muted)}
              >{mpvState.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
              <input
                type="range"
                aria-label="音量"
                min="0"
                max="100"
                step="1"
                value={mpvState.volume}
                onChange={(event) => void mpvClient.setVolume(Number(event.currentTarget.value))}
              />
              <button
                type="button"
                aria-label={videoFocus ? "退出全屏" : "进入全屏"}
                onClick={() => {
                  if (!isTauri()) return;
                  const next = !videoFocus;
                  setVideoFocus(next);
                  void getCurrentWindow().setFullscreen(next).catch(() => setVideoFocus(!next));
                }}
              >{videoFocus ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
            </div>
          )}
          <div className="video-timeline">
            <input
              aria-label="视频进度"
              type="range"
              min="0"
              max={videoDuration}
              step="0.01"
              value={Math.min(videoCurrentTime, videoDuration || 0)}
              disabled={!videoDuration}
              onChange={(event) => seekFreely(Number(event.currentTarget.value))}
            />
            <output>{formatVideoTime(videoCurrentTime)} / {formatVideoTime(videoDuration)}</output>
          </div>
          <div className="video-meta">
            <span>{task.videoPath.split("/").pop()}</span>
            <span>可拖动进度条自由定位 · 原视频不会被修改</span>
          </div>
          <button
            className="secondary-button replay-button"
            disabled={mpvMode === "active" ? !mpvState.ready || !videoDuration : !videoDuration}
            onClick={replayVideo}
          ><RotateCcw size={16} /> 重播视频</button>
        </aside>

        <section className="annotation-pane">
          <div className="theme-tabs" role="tablist" aria-label="标注主题">
            {(Object.keys(THEME_LABELS) as Theme[]).map((item) => {
              const themeUnits = units.filter((unit) => unit.theme === item);
              const done = themeUnits.filter((unit) => task.records[unit.id]).length;
              return (
                <button key={item} role="tab" aria-selected={theme === item} className={theme === item ? "theme-tab active" : "theme-tab"} onClick={() => selectTheme(item)}>
                  {THEME_LABELS[item]} <span>{done}/{themeUnits.length}</span>
                </button>
              );
            })}
          </div>
          <div className="unit-list">
            {visibleUnits.map((unit) => (
              <UnitCard
                key={unit.id}
                unit={unit}
                active={unit.id === activeUnitId}
                record={task.records[unit.id]}
                draft={task.drafts[unit.id]}
                onSelect={() => selectUnit(unit)}
                onCommit={commitAndAdvance}
                onDraft={onDraft}
              />
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

interface UnitCardProps {
  unit: AnnotationUnit;
  active: boolean;
  record: ProjectTask["records"][string] | undefined;
  draft: ProjectTask["drafts"][string] | undefined;
  onSelect: () => void;
  onCommit: AnnotationWorkspaceProps["onCommit"];
  onDraft: AnnotationWorkspaceProps["onDraft"];
}

function UnitCard({ unit, active, record, draft, onSelect, onCommit, onDraft }: UnitCardProps) {
  const savedCorrection = record?.decision === "false" ? record.correctedFields : undefined;
  const initialFields = draft?.fields ?? savedCorrection ?? unit.sourceFields;
  const [editingFalse, setEditingFalse] = useState(Boolean(draft));
  const [showQuestionHelp, setShowQuestionHelp] = useState(false);
  const [showOtherHelp, setShowOtherHelp] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>(initialFields);
  const changed = editingFalse ? validateCorrection("false", unit.sourceFields, fields) : false;
  const selectedDecision: Decision = editingFalse ? "false" : (record?.decision ?? "pending");

  useEffect(() => {
    if (editingFalse) onDraft(unit.id, "false", fields);
  }, [editingFalse, fields]); // eslint-disable-line react-hooks/exhaustive-deps

  const startFalseEdit = () => {
    setFields(draft?.fields ?? savedCorrection ?? unit.sourceFields);
    setEditingFalse(true);
  };

  return (
    <article id={`unit-card-${unit.id}`} className={`unit-card ${active ? "active" : ""}`} onClick={onSelect}>
      <div className="unit-heading">
        <div><span className="unit-index">{unit.title}</span>{unit.subtitle && <small>{unit.subtitle}</small>}</div>
        <DecisionBadge decision={record?.decision ?? "pending"} hasDraft={Boolean(draft) || editingFalse} />
      </div>

      <div className="source-fields">
        {Object.entries(unit.sourceFields).map(([key, value]) => {
          const labels = FIELD_LABELS[key] ?? { english: key, chinese: key };
          return (
            <div key={key} className="source-field bilingual-field">
              <div className="english-source">
                <span>{labels.english} · English original</span>
                <p>{value}</p>
              </div>
              <div className="chinese-reference">
                <span>{labels.chinese} · 中文参考（只读）</span>
                <p>{unit.referenceFields[key] ?? ""}</p>
              </div>
            </div>
          );
        })}
      </div>

      <div className="decision-row" onClick={(event) => event.stopPropagation()}>
        <button aria-pressed={selectedDecision === "true"} className={selectedDecision === "true" ? "decision true selected" : "decision true"} onClick={() => {
          setEditingFalse(false);
          onCommit(unit.id, "true", unit.sourceFields);
        }}><Check size={16} /> True</button>
        <button aria-pressed={selectedDecision === "false"} id={`${unit.id}-false`} className={selectedDecision === "false" ? "decision false selected" : "decision false"} onClick={startFalseEdit}>
          <X size={16} /> False
        </button>
        <span
          className="decision-help-control"
          onMouseEnter={() => setShowQuestionHelp(true)}
          onMouseLeave={() => setShowQuestionHelp(false)}
          onFocus={() => setShowQuestionHelp(true)}
          onBlur={() => setShowQuestionHelp(false)}
        >
          <button
            id={`${unit.id}-question`}
            aria-pressed={selectedDecision === "question"}
            className={selectedDecision === "question" ? "decision question selected" : "decision question"}
            aria-describedby={showQuestionHelp ? `${unit.id}-question-tooltip` : undefined}
            onClick={() => {
              setEditingFalse(false);
              onCommit(unit.id, "question", unit.sourceFields);
            }}
          >
            <CircleHelp size={16} /> Question
          </button>
          {showQuestionHelp && (
            <span id={`${unit.id}-question-tooltip`} className="decision-tooltip" role="tooltip">
              Question：事件匹配不准确，但受当前分段、说话人或时间范围限制，无法合理修订；问题不属于严重错误。
            </span>
          )}
        </span>
        <span
          className="decision-help-control"
          onMouseEnter={() => setShowOtherHelp(true)}
          onMouseLeave={() => setShowOtherHelp(false)}
          onFocus={() => setShowOtherHelp(true)}
          onBlur={() => setShowOtherHelp(false)}
        >
          <button
            id={`${unit.id}-other`}
            aria-pressed={selectedDecision === "other"}
            className={selectedDecision === "other" ? "decision other selected" : "decision other"}
            aria-describedby={showOtherHelp ? `${unit.id}-other-tooltip` : undefined}
            onClick={() => {
              setEditingFalse(false);
              onCommit(unit.id, "other", unit.sourceFields);
            }}
          >
            <CircleAlert size={16} /> Other
          </button>
          {showOtherHelp && (
            <span id={`${unit.id}-other-tooltip`} className="decision-tooltip" role="tooltip">
              Other：人物或事件本身存在严重错误，无需修改文本。
            </span>
          )}
        </span>
      </div>

      {editingFalse && (
        <div
          className="inline-editor"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="editor-title"><strong>修订英文内容</strong><span>至少修改一个英文可编辑字段后保存</span></div>
          {unit.editableKeys.map((key) => (
            <label key={key}>
              <span>{FIELD_LABELS[key]?.english ?? key}</span>
              <textarea
                aria-label={`修订 ${key}`}
                value={fields[key] ?? ""}
                rows={["description", "content", "overall_visual_style", "overall_audio_style", "narrative_theme", "profile"].includes(key) ? 5 : 2}
                onChange={(event) => setFields((current) => ({ ...current, [key]: event.target.value }))}
              />
            </label>
          ))}
          <div className="editor-actions">
            <button className="text-button" onClick={() => setEditingFalse(false)}>收起并保留草稿</button>
            <button className="primary-button" disabled={!changed} onClick={() => {
              onCommit(unit.id, "false", fields);
              setEditingFalse(false);
            }}><Save size={16} /> 保存修订</button>
          </div>
        </div>
      )}
    </article>
  );
}

function DecisionBadge({ decision, hasDraft }: { decision: Decision; hasDraft: boolean }) {
  if (hasDraft && decision === "pending") return <span className="status-badge draft">False 草稿</span>;
  const labels: Record<Decision, string> = { pending: "待标注", true: "True", false: "False", question: "Question", other: "Other" };
  return <span className={`status-badge ${decision}`}>{labels[decision]}</span>;
}
