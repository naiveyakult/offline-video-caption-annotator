import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@tauri-apps/api/core";
import { AnnotationWorkspace } from "./components/AnnotationWorkspace";
import { ProfileDialog } from "./components/ProfileDialog";
import { ProjectDashboard } from "./components/ProjectDashboard";
import { useAppStore } from "./store/app-store";
import {
  BrowserProjectStorage,
  createProjectStorage,
  type ProjectStorage,
} from "./storage/project-storage";

export default function App() {
  const annotatorId = useAppStore((state) => state.annotatorId);
  const annotationFontSize = useAppStore((state) => state.annotationFontSize);
  const project = useAppStore((state) => state.project);
  const screen = useAppStore((state) => state.screen);
  const activeTaskId = useAppStore((state) => state.activeTaskId);
  const setAnnotatorId = useAppStore((state) => state.setAnnotatorId);
  const setAnnotationFontSize = useAppStore((state) => state.setAnnotationFontSize);
  const setProject = useAppStore((state) => state.setProject);
  const openTask = useAppStore((state) => state.openTask);
  const closeTask = useAppStore((state) => state.closeTask);
  const commit = useAppStore((state) => state.commit);
  const saveDraft = useAppStore((state) => state.saveDraft);
  const setVideoPosition = useAppStore((state) => state.setVideoPosition);
  const setTheme = useAppStore((state) => state.setTheme);
  const setActiveUnit = useAppStore((state) => state.setActiveUnit);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string>();
  const storageRef = useRef<ProjectStorage>(createProjectStorage());
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!project) return;
    const timer = window.setTimeout(() => {
      void storageRef.current.saveProject(project).catch((error) => {
        setToast(`自动保存失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [project?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(undefined), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const openProject = async () => {
    if (!annotatorId) return;
    if (!isTauri()) {
      fileInputRef.current?.click();
      return;
    }
    const path = await open({ directory: true, multiple: false, title: "选择标注项目文件夹" });
    if (!path) return;
    setLoading(true);
    try {
      setProject(await storageRef.current.openProject(path));
    } catch (error) {
      setToast(`打开项目失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  const openBrowserFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setLoading(true);
    try {
      const browserStorage = storageRef.current as BrowserProjectStorage;
      setProject(await browserStorage.openFiles(files));
    } catch (error) {
      setToast(`打开项目失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const exportProject = async () => {
    if (!project) return;
    try {
      const result = await storageRef.current.exportProject(project, annotatorId);
      setToast(`已导出 ${result.taskCount} 个任务（${result.status === "complete" ? "完整" : "部分"}）：${result.outputPath}`);
    } catch (error) {
      setToast(`导出失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const activeTask = project?.tasks.find((task) => task.id === activeTaskId);
  const validTasks = project?.tasks.filter((task) => task.document) ?? [];
  const activeTaskIndex = validTasks.findIndex((task) => task.id === activeTaskId);
  const previousTask = activeTaskIndex > 0 ? validTasks[activeTaskIndex - 1] : undefined;
  const nextTask = activeTaskIndex >= 0 && activeTaskIndex < validTasks.length - 1
    ? validTasks[activeTaskIndex + 1]
    : undefined;

  return (
    <>
      <input
        ref={fileInputRef}
        className="sr-only"
        type="file"
        multiple
        {...({ webkitdirectory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
        onChange={(event) => void openBrowserFiles(event.target.files)}
      />
      {!annotatorId && <ProfileDialog initialValue="" required onSave={setAnnotatorId} />}
      {settingsOpen && (
        <ProfileDialog
          initialValue={annotatorId}
          onSave={(value) => { setAnnotatorId(value); setSettingsOpen(false); }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {screen === "workspace" && activeTask?.document ? (
        <AnnotationWorkspace
          key={activeTask.id}
          task={activeTask}
          annotationFontSize={annotationFontSize}
          initialTheme={project?.activeTheme}
          initialUnitId={project?.activeUnitId}
          onBack={closeTask}
          onPreviousTask={previousTask ? () => openTask(previousTask.id) : undefined}
          onNextTask={nextTask ? () => openTask(nextTask.id) : undefined}
          onExport={() => void exportProject()}
          onCommit={commit}
          onDraft={saveDraft}
          onVideoPosition={setVideoPosition}
          onThemeChange={setTheme}
          onUnitChange={setActiveUnit}
          onAnnotationFontSizeChange={setAnnotationFontSize}
        />
      ) : (
        <ProjectDashboard
          project={project}
          annotatorId={annotatorId}
          loading={loading}
          onOpenProject={() => void openProject()}
          onOpenTask={openTask}
          onExport={() => void exportProject()}
          onSettings={() => setSettingsOpen(true)}
        />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}
