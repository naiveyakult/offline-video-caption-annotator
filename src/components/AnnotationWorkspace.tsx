import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Check,
  CircleAlert,
  Download,
  Play,
  RotateCcw,
  Save,
  X,
} from "lucide-react";
import { buildAnnotationUnits, timeToSeconds, validateCorrection } from "../domain/annotation";
import type {
  AnnotationFontSize,
  AnnotationUnit,
  Decision,
  ProjectTask,
  Theme,
} from "../domain/types";

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
  const [segmentEnd, setSegmentEnd] = useState<number>();
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const programmaticSeekRef = useRef(false);

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

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.tagName === "TEXTAREA" || target?.tagName === "INPUT";
      if (editing) return;
      const activeUnit = units.find((unit) => unit.id === activeUnitId);
      if (!activeUnit) return;
      const shortcut = event.key.toLowerCase();
      const hasModifier = event.metaKey || event.ctrlKey || event.altKey;
      if (!hasModifier && shortcut === "t") {
        event.preventDefault();
        onCommit(activeUnit.id, "true", activeUnit.sourceFields);
        advanceFrom(activeUnit.id);
      }
      if (!hasModifier && (shortcut === "f" || shortcut === "o")) {
        event.preventDefault();
        document.getElementById(`${activeUnit.id}-${shortcut === "f" ? "false" : "other"}`)?.click();
      }
      if (event.code === "Space") {
        event.preventDefault();
        const video = videoRef.current;
        if (video) void (video.paused ? video.play() : video.pause());
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [activeUnitId, onCommit, onUnitChange, task.records, units, visibleUnits]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectTheme = (nextTheme: Theme) => {
    setTheme(nextTheme);
    onThemeChange?.(nextTheme);
  };

  const playUnit = (unit: AnnotationUnit) => {
    setActiveUnitId(unit.id);
    onUnitChange?.(unit.id);
    if (!unit.startTime || !unit.endTime || !videoRef.current) return;
    programmaticSeekRef.current = true;
    const start = timeToSeconds(unit.startTime);
    videoRef.current.currentTime = start;
    setVideoCurrentTime(start);
    setSegmentEnd(timeToSeconds(unit.endTime));
    void videoRef.current.play();
  };

  const seekFreely = (position: number) => {
    const video = videoRef.current;
    if (!video) return;
    const next = Math.max(0, Math.min(position, videoDuration || 0));
    setSegmentEnd(undefined);
    programmaticSeekRef.current = false;
    video.currentTime = next;
    setVideoCurrentTime(next);
    onVideoPosition(next);
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
      className="workspace-shell"
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
          <section className="header-shortcuts" role="region" aria-label="快捷键说明">
            <span className="shortcut-heading">快捷键</span>
            <span className="shortcut-item"><span>True</span><kbd>T</kbd></span>
            <span className="shortcut-separator" aria-hidden="true">·</span>
            <span className="shortcut-item"><span>False</span><kbd>F</kbd></span>
            <span className="shortcut-separator" aria-hidden="true">·</span>
            <span className="shortcut-item"><span>Other</span><kbd>O</kbd></span>
            <span className="shortcut-separator" aria-hidden="true">·</span>
            <span className="shortcut-item"><span>保存 False</span><kbd>⌘↵ / Ctrl+↵</kbd></span>
            <span className="shortcut-separator" aria-hidden="true">·</span>
            <span className="shortcut-item"><span>播放</span><kbd>Space</kbd></span>
          </section>
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
            <video
              ref={videoRef}
              src={task.videoUrl || undefined}
              controls
              preload="metadata"
              onLoadedMetadata={(event) => {
                const duration = Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0;
                setVideoDuration(duration);
                programmaticSeekRef.current = true;
                const restored = Math.min(task.videoPosition, duration || 0);
                event.currentTarget.currentTime = restored;
                setVideoCurrentTime(restored);
              }}
              onDurationChange={(event) => setVideoDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
              onSeeking={() => {
                if (!programmaticSeekRef.current) setSegmentEnd(undefined);
              }}
              onSeeked={() => { programmaticSeekRef.current = false; }}
              onTimeUpdate={(event) => {
                const current = event.currentTarget.currentTime;
                setVideoCurrentTime(current);
                onVideoPosition(current);
                if (segmentEnd !== undefined && current >= segmentEnd) {
                  event.currentTarget.pause();
                  setSegmentEnd(undefined);
                }
              }}
            />
          </div>
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
          {activeUnitId && units.find((unit) => unit.id === activeUnitId)?.startTime && (
            <button className="secondary-button replay-button" onClick={() => {
              const unit = units.find((item) => item.id === activeUnitId);
              if (unit) playUnit(unit);
            }}><RotateCcw size={16} /> 重播当前片段</button>
          )}
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
                onSelect={() => playUnit(unit)}
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

  const handleEditorKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const saveShortcut = event.key === "Enter"
      && (event.metaKey || event.ctrlKey)
      && !event.altKey;
    if (!saveShortcut) return;
    event.preventDefault();
    event.stopPropagation();
    if (!changed) return;
    onCommit(unit.id, "false", fields);
    setEditingFalse(false);
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
        <button className={selectedDecision === "true" ? "decision true selected" : "decision true"} onClick={() => {
          setEditingFalse(false);
          onCommit(unit.id, "true", unit.sourceFields);
        }}><Check size={16} /> True</button>
        <button id={`${unit.id}-false`} className={selectedDecision === "false" ? "decision false selected" : "decision false"} onClick={startFalseEdit}>
          <X size={16} /> False
        </button>
        <span
          className="other-control"
          onMouseEnter={() => setShowOtherHelp(true)}
          onMouseLeave={() => setShowOtherHelp(false)}
          onFocus={() => setShowOtherHelp(true)}
          onBlur={() => setShowOtherHelp(false)}
        >
          <button
            id={`${unit.id}-other`}
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
            <span id={`${unit.id}-other-tooltip`} className="other-tooltip" role="tooltip">
              Other：人物或事件本身存在严重错误，无需修改文本。
            </span>
          )}
        </span>
        {unit.startTime && <button className="segment-play" onClick={onSelect} aria-label={`播放 ${unit.title}`}><Play size={15} /> 播放片段</button>}
      </div>

      {editingFalse && (
        <div
          className="inline-editor"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={handleEditorKeyDown}
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
  const labels: Record<Decision, string> = { pending: "待标注", true: "True", false: "False", other: "Other" };
  return <span className={`status-badge ${decision}`}>{labels[decision]}</span>;
}
