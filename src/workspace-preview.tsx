import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AnnotationWorkspace } from "./components/AnnotationWorkspace";
import { parseVideoDocument } from "./domain/annotation";
import type { AnnotationFontSize, AnnotationRecord, DraftRecord, ProjectTask } from "./domain/types";
import { captionFixture } from "./test/caption-fixture";
import "./styles.css";

const source = parseVideoDocument(JSON.stringify(captionFixture));

export function Preview() {
  const [records, setRecords] = useState<Record<string, AnnotationRecord>>({});
  const [drafts, setDrafts] = useState<Record<string, DraftRecord>>({});
  const [annotationFontSize, setAnnotationFontSize] = useState<AnnotationFontSize>(14);
  const task: ProjectTask = {
    id: "preview-001",
    jsonPath: "preview-001.json",
    videoPath: "preview-001.mp4",
    videoUrl: "",
    sourceSha256: "preview",
    document: source,
    status: Object.keys(records).length === 9 ? "complete" : Object.keys(records).length || Object.keys(drafts).length ? "in_progress" : "not_started",
    records,
    drafts,
    videoPosition: 0,
  };
  return (
    <AnnotationWorkspace
      task={task}
      annotationFontSize={annotationFontSize}
      onAnnotationFontSizeChange={setAnnotationFontSize}
      onBack={() => undefined}
      onVideoPosition={() => undefined}
      onDraft={(unitId, decision, fields) => {
        setRecords((current) => {
          const next = { ...current };
          delete next[unitId];
          return next;
        });
        setDrafts((current) => ({ ...current, [unitId]: { unitId, decision, fields, updatedAt: new Date().toISOString() } }));
      }}
      onCommit={(unitId, decision, fields) => {
        setRecords((current) => ({
          ...current,
          [unitId]: { unitId, decision, correctedFields: decision === "false" ? fields : {}, updatedAt: new Date().toISOString() },
        }));
        setDrafts((current) => {
          const next = { ...current };
          delete next[unitId];
          return next;
        });
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
