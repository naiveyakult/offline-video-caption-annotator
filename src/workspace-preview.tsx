import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AnnotationWorkspace } from "./components/AnnotationWorkspace";
import { parseVideoDocument } from "./domain/annotation";
import type { AnnotationFontSize, AnnotationRecord, ProjectTask } from "./domain/types";
import { captionFixture } from "./test/caption-fixture";
import "./styles.css";

const source = parseVideoDocument(JSON.stringify(captionFixture));

export function Preview() {
  const [records, setRecords] = useState<Record<string, AnnotationRecord>>({});
  const [annotationFontSize, setAnnotationFontSize] = useState<AnnotationFontSize>(14);
  const task: ProjectTask = {
    id: "preview-001",
    jsonPath: "preview-001.json",
    videoPath: "preview-001.mp4",
    videoUrl: "",
    sourceSha256: "preview",
    document: source,
    status: Object.values(records).some((record) => record.decision === "false") || Object.keys(records).length === 9
      ? "complete"
      : Object.keys(records).length ? "in_progress" : "not_started",
    records,
    drafts: {},
    videoPosition: 0,
  };
  return (
    <AnnotationWorkspace
      task={task}
      annotationFontSize={annotationFontSize}
      onAnnotationFontSizeChange={setAnnotationFontSize}
      onBack={() => undefined}
      onVideoPosition={() => undefined}
      onCommit={(unitId, decision, fields) => {
        setRecords((current) => ({
          ...current,
          [unitId]: { unitId, decision, correctedFields: decision === "false" ? fields : {}, updatedAt: new Date().toISOString() },
        }));
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
