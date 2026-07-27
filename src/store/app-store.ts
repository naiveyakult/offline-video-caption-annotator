import { create } from "zustand";
import type {
  AnnotationFontSize,
  AnnotationRecord,
  Decision,
  ProjectSnapshot,
  Theme,
} from "../domain/types";
import { updateTaskStatus } from "../storage/project-storage";

interface AppState {
  annotatorId: string;
  annotationFontSize: AnnotationFontSize;
  project?: ProjectSnapshot;
  screen: "dashboard" | "workspace";
  activeTaskId?: string;
  setAnnotatorId: (value: string) => void;
  setAnnotationFontSize: (value: AnnotationFontSize) => void;
  setProject: (project: ProjectSnapshot) => void;
  openTask: (taskId: string) => void;
  closeTask: () => void;
  commit: (
    unitId: string,
    decision: Exclude<Decision, "pending">,
    fields: Record<string, string>,
  ) => void;
  setVideoPosition: (position: number) => void;
  setTheme: (theme: Theme) => void;
  setActiveUnit: (unitId: string) => void;
}

const ANNOTATOR_KEY = "video-annotator:annotator-id";
const ANNOTATION_FONT_SIZE_KEY = "video-annotator:annotation-font-size";

function readAnnotationFontSize(): AnnotationFontSize {
  const stored = Number(localStorage.getItem(ANNOTATION_FONT_SIZE_KEY));
  return stored === 12 || stored === 14 || stored === 16 ? stored : 14;
}

export const useAppStore = create<AppState>((set) => ({
  annotatorId: localStorage.getItem(ANNOTATOR_KEY) ?? "",
  annotationFontSize: readAnnotationFontSize(),
  screen: "dashboard",
  setAnnotatorId: (value) => {
    localStorage.setItem(ANNOTATOR_KEY, value.trim());
    set({ annotatorId: value.trim() });
  },
  setAnnotationFontSize: (value) => {
    localStorage.setItem(ANNOTATION_FONT_SIZE_KEY, String(value));
    set({ annotationFontSize: value });
  },
  setProject: (project) => set({
    project,
    activeTaskId: project.activeTaskId,
    screen: project.activeTaskId ? "workspace" : "dashboard",
  }),
  openTask: (taskId) => set((state) => ({
    activeTaskId: taskId,
    screen: "workspace",
    project: state.project ? { ...state.project, activeTaskId: taskId, updatedAt: new Date().toISOString() } : undefined,
  })),
  closeTask: () => set((state) => ({
    screen: "dashboard",
    project: state.project ? { ...state.project, activeTaskId: undefined, updatedAt: new Date().toISOString() } : undefined,
  })),
  commit: (unitId, decision, fields) => set((state) => {
    void fields;
    if (!state.project || !state.activeTaskId) return state;
    const tasks = state.project.tasks.map((task) => {
      if (task.id !== state.activeTaskId) return task;
      const record: AnnotationRecord = {
        unitId,
        decision,
        correctedFields: {},
        updatedAt: new Date().toISOString(),
      };
      const records = { ...task.records, [unitId]: record };
      if (decision === "false") {
        return updateTaskStatus({
          ...task,
          records,
          videoDecision: "false",
          completionMode: "false_early_stop",
          stoppedAtUnitId: unitId,
        });
      }
      const clearsEarlyStop = task.stoppedAtUnitId === unitId;
      return updateTaskStatus({
        ...task,
        records,
        ...(clearsEarlyStop ? {
          videoDecision: undefined,
          completionMode: undefined,
          stoppedAtUnitId: undefined,
        } : {}),
      });
    });
    return { project: { ...state.project, tasks, updatedAt: new Date().toISOString() } };
  }),
  setVideoPosition: (position) => set((state) => {
    if (!state.project || !state.activeTaskId) return state;
    return {
      project: {
        ...state.project,
        tasks: state.project.tasks.map((task) => task.id === state.activeTaskId ? { ...task, videoPosition: position } : task),
        updatedAt: new Date().toISOString(),
      },
    };
  }),
  setTheme: (theme) => set((state) => ({
    project: state.project ? { ...state.project, activeTheme: theme, updatedAt: new Date().toISOString() } : undefined,
  })),
  setActiveUnit: (unitId) => set((state) => ({
    project: state.project ? { ...state.project, activeUnitId: unitId, updatedAt: new Date().toISOString() } : undefined,
  })),
}));
