export type Theme = "overview" | "storyline" | "speech_transcript";
export type Decision = "pending" | "true" | "false" | "other";

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
  decision: Decision;
  source_fields: Record<string, string>;
  corrected_fields: Record<string, string>;
  updated_at: string | null;
}

export interface AnnotationMeta {
  schema_version: "2.0";
  task_id: string;
  annotator_id: string;
  source_sha256: string;
  export_status: "partial" | "complete";
  exported_at: string;
  counts: {
    total: number;
    pending: number;
    true: number;
    false: number;
    other: number;
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
}
