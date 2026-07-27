export type Theme = "overview" | "storyline" | "speech_transcript";
export type Decision = "pending" | "true" | "false";
export type AnnotationFontSize = 12 | 14 | 16;

export interface VideoDocument {
  caption_en: string;
  caption_zh: string;
  [key: string]: unknown;
}

export interface AnnotationUnit {
  id: string;
  theme: Theme;
  title: string;
  subtitle?: string;
  sourceFields: Record<string, string>;
  referenceFields: Record<string, string>;
  editableKeys: string[];
  startTime?: string;
  endTime?: string;
}

export interface AnnotationRecord {
  unitId: string;
  decision: Exclude<Decision, "pending">;
  correctedFields: Record<string, string>;
  updatedAt: string;
  legacyDecision?: "question" | "other";
  legacyCorrectedFields?: Record<string, string>;
}

export interface DraftRecord {
  unitId: string;
  decision: "false";
  fields: Record<string, string>;
  updatedAt: string;
}

export interface AnnotationMetaUnit {
  unit_id: string;
  theme: Theme;
  decision: Exclude<Decision, "pending">;
  source_fields: Record<string, string>;
  updated_at: string;
}

export interface AnnotationMeta {
  schema_version: "3.0";
  task_id: string;
  annotator_id: string;
  source_sha256: string;
  export_status: "complete";
  video_decision: Exclude<Decision, "pending">;
  completion_mode: "all_units" | "false_early_stop";
  stopped_at_unit_id: string | null;
  exported_at: string;
  counts: {
    source_total: number;
    annotated: number;
    true: number;
    false: number;
    unreviewed: number;
  };
  units: AnnotationMetaUnit[];
}

export type TaskStatus = "not_started" | "in_progress" | "complete" | "invalid";

export interface ProjectTask {
  id: string;
  jsonPath: string;
  videoPath: string;
  videoUrl: string;
  sourceSha256: string;
  document?: VideoDocument;
  error?: string;
  status: TaskStatus;
  videoDecision?: Exclude<Decision, "pending">;
  completionMode?: "all_units" | "false_early_stop";
  stoppedAtUnitId?: string;
  records: Record<string, AnnotationRecord>;
  drafts: Record<string, DraftRecord>;
  videoPosition: number;
}

export interface ProjectSnapshot {
  rootPath: string;
  name: string;
  tasks: ProjectTask[];
  activeTaskId?: string;
  activeTheme: Theme;
  activeUnitId?: string;
  updatedAt: string;
}

export interface ExportResult {
  outputPath: string;
  status: "partial" | "complete";
  taskCount: number;
  taskCounts: {
    total: number;
    exported: number;
    notStarted: number;
    inProgress: number;
    complete: number;
    invalid: number;
    skipped: number;
  };
}
