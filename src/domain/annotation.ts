import { z } from "zod";
import type {
  AnnotationMeta,
  AnnotationRecord,
  AnnotationUnit,
  Decision,
  Theme,
  VideoDocument,
} from "./types";

const TIME_PATTERN = /^\d{2,}:\d{2}\.\d{3}$/;
const RANGE_PATTERN = /^(\d{2,}:\d{2}\.\d{3})[ \t]*-[ \t]*(\d{2,}:\d{2}\.\d{3})[ \t]*\r?$/gm;

const captionDocumentSchema = z
  .object({
    caption_en: z.string().min(1),
    caption_zh: z.string().min(1),
  })
  .passthrough();

interface TextRange {
  start: number;
  end: number;
}

interface FieldSpan extends TextRange {
  value: string;
}

interface ParsedUnit {
  id: string;
  theme: Theme;
  title: string;
  subtitle?: string;
  fields: Record<string, FieldSpan>;
  editableKeys: string[];
  startTime?: string;
  endTime?: string;
}

interface CaptionSections {
  overview: TextRange;
  storyline: TextRange;
  speech: TextRange;
  visibleText: TextRange;
}

const EN_HEADINGS = ["## Overview", "## Storyline", "## Speech Transcript", "## Visible Text"] as const;
const ZH_HEADINGS = ["## 概览", "## 故事线", "## 语音转录", "## 可见文字"] as const;

const EN_OVERVIEW_LABELS = [
  ["overall_visual_style", "Overall Visual Style:"],
  ["overall_audio_style", "Overall Audio Style:"],
  ["character_profiles", "Character Profiles:"],
  ["narrative_theme", "Narrative Theme:"],
] as const;

const ZH_OVERVIEW_LABELS = [
  ["overall_visual_style", "整体视觉风格："],
  ["overall_audio_style", "整体音频风格："],
  ["character_profiles", "人物档案："],
  ["narrative_theme", "叙事主题："],
] as const;

const EN_SPEECH_LABELS = [
  ["speaker", "Speaker:"],
  ["state", "State:"],
  ["content", "Content:"],
] as const;

const ZH_SPEECH_LABELS = [
  ["speaker", "说话人："],
  ["state", "状态："],
  ["content", "内容："],
] as const;

export function timeToSeconds(value: string): number {
  if (!TIME_PATTERN.test(value)) return Number.NaN;
  const [minutesPart, secondsPart] = value.split(":");
  return Number(minutesPart) * 60 + Number(secondsPart);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimRange(content: string, start: number, end: number): FieldSpan {
  while (start < end && /\s/.test(content[start] ?? "")) start += 1;
  while (end > start && /\s/.test(content[end - 1] ?? "")) end -= 1;
  return { start, end, value: content.slice(start, end) };
}

function extractSections(content: string, headings: readonly string[]): CaptionSections {
  const matches = headings.map((heading) => {
    const expression = new RegExp(`^${escapeRegExp(heading)}[ \\t]*\\r?$`, "m");
    const match = expression.exec(content);
    if (!match || match.index === undefined) throw new Error(`缺少固定章节标题：${heading}`);
    return { heading, start: match.index, contentStart: match.index + match[0].length };
  });

  for (let index = 1; index < matches.length; index += 1) {
    if (matches[index]!.start <= matches[index - 1]!.start) {
      throw new Error("四个章节标题顺序必须为 Overview、Storyline、Speech Transcript、Visible Text");
    }
  }

  const ranges = matches.map((match, index) => ({
    start: match.contentStart,
    end: matches[index + 1]?.start ?? content.length,
  }));
  return {
    overview: ranges[0]!,
    storyline: ranges[1]!,
    speech: ranges[2]!,
    visibleText: ranges[3]!,
  };
}

function parseStandaloneLabels(
  content: string,
  section: TextRange,
  definitions: readonly (readonly [string, string])[],
  context: string,
): Record<string, FieldSpan> {
  const matches = definitions.map(([key, label]) => {
    const expression = new RegExp(`^${escapeRegExp(label)}[ \\t]*\\r?$`, "gm");
    expression.lastIndex = section.start;
    const match = expression.exec(content);
    if (!match || match.index < section.start || match.index >= section.end) {
      throw new Error(`${context} 缺少固定字段：${label}`);
    }
    return { key, label, start: match.index, valueStart: match.index + match[0].length };
  });

  matches.forEach((match, index) => {
    if (index > 0 && match.start <= matches[index - 1]!.start) {
      throw new Error(`${context} 字段顺序错误：${match.label}`);
    }
  });

  return Object.fromEntries(matches.map((match, index) => [
    match.key,
    trimRange(content, match.valueStart, matches[index + 1]?.start ?? section.end),
  ]));
}

function splitProfiles(content: string, span: FieldSpan): FieldSpan[] {
  if (!span.value) return [];
  const lineExpression = /[^\r\n]+/g;
  const lineMatches = [...span.value.matchAll(lineExpression)].map((match) => {
    const start = span.start + (match.index ?? 0);
    return trimRange(content, start, start + match[0].length);
  }).filter((item) => item.value.length > 0);
  if (lineMatches.length > 1) return lineMatches;

  const paragraphs: FieldSpan[] = [];
  const separator = /\r?\n[ \t]*\r?\n/g;
  let cursor = span.start;
  for (const match of content.slice(span.start, span.end).matchAll(separator)) {
    const boundary = span.start + (match.index ?? 0);
    const paragraph = trimRange(content, cursor, boundary);
    if (paragraph.value) paragraphs.push(paragraph);
    cursor = boundary + match[0].length;
  }
  const finalParagraph = trimRange(content, cursor, span.end);
  if (finalParagraph.value) paragraphs.push(finalParagraph);
  return paragraphs;
}

function parseTimeRanges(content: string, section: TextRange, context: string) {
  const expression = new RegExp(RANGE_PATTERN.source, RANGE_PATTERN.flags);
  expression.lastIndex = section.start;
  const matches: Array<{ start: number; end: number; startTime: string; endTime: string }> = [];
  for (const match of content.matchAll(expression)) {
    const start = match.index ?? 0;
    if (start < section.start) continue;
    if (start >= section.end) break;
    const startTime = match[1]!;
    const endTime = match[2]!;
    const seconds = Number(startTime.split(":")[1]?.split(".")[0]);
    const endSeconds = Number(endTime.split(":")[1]?.split(".")[0]);
    if (seconds >= 60 || endSeconds >= 60) throw new Error(`${context} 时间秒数必须在 00-59 之间`);
    if (timeToSeconds(endTime) < timeToSeconds(startTime)) throw new Error(`${context} 结束时间不能早于开始时间`);
    matches.push({ start, end: start + match[0].length, startTime, endTime });
  }
  return matches;
}

function parseInlineLabels(
  content: string,
  block: TextRange,
  definitions: readonly (readonly [string, string])[],
  context: string,
): Record<string, FieldSpan> {
  const matches = definitions.map(([key, label]) => {
    const expression = new RegExp(`^${escapeRegExp(label)}[ \\t]*`, "gm");
    expression.lastIndex = block.start;
    const match = expression.exec(content);
    if (!match || match.index < block.start || match.index >= block.end) {
      throw new Error(`${context} 缺少固定字段：${label}`);
    }
    return { key, label, start: match.index, valueStart: match.index + match[0].length };
  });
  matches.forEach((match, index) => {
    if (index > 0 && match.start <= matches[index - 1]!.start) throw new Error(`${context} 字段顺序错误：${match.label}`);
  });
  return Object.fromEntries(matches.map((match, index) => [
    match.key,
    trimRange(content, match.valueStart, matches[index + 1]?.start ?? block.end),
  ]));
}

function parseCaption(content: string, chinese: boolean): ParsedUnit[] {
  const sections = extractSections(content, chinese ? ZH_HEADINGS : EN_HEADINGS);
  const overviewFields = parseStandaloneLabels(
    content,
    sections.overview,
    chinese ? ZH_OVERVIEW_LABELS : EN_OVERVIEW_LABELS,
    chinese ? "概览" : "Overview",
  );
  const units: ParsedUnit[] = [
    {
      id: "overview.overall_visual_style",
      theme: "overview",
      title: "Overall Visual Style",
      fields: { overall_visual_style: overviewFields.overall_visual_style! },
      editableKeys: ["overall_visual_style"],
    },
    {
      id: "overview.overall_audio_style",
      theme: "overview",
      title: "Overall Audio Style",
      fields: { overall_audio_style: overviewFields.overall_audio_style! },
      editableKeys: ["overall_audio_style"],
    },
  ];

  splitProfiles(content, overviewFields.character_profiles!).forEach((profile, index) => {
    units.push({
      id: `overview.character_profiles.${index}`,
      theme: "overview",
      title: `Character Profile ${index + 1}`,
      fields: { profile },
      editableKeys: ["profile"],
    });
  });
  units.push({
    id: "overview.narrative_theme",
    theme: "overview",
    title: "Narrative Theme",
    fields: { narrative_theme: overviewFields.narrative_theme! },
    editableKeys: ["narrative_theme"],
  });

  const storylineRanges = parseTimeRanges(content, sections.storyline, chinese ? "故事线" : "Storyline");
  if (storylineRanges.length === 0) throw new Error(`${chinese ? "故事线" : "Storyline"} 至少需要一个时间范围`);
  storylineRanges.forEach((range, index) => {
    const description = trimRange(content, range.end, storylineRanges[index + 1]?.start ?? sections.storyline.end);
    if (!description.value) throw new Error(`${chinese ? "故事线" : "Storyline"} 第 ${index + 1} 条缺少正文`);
    units.push({
      id: `storyline.${index}`,
      theme: "storyline",
      title: `Storyline ${index + 1}`,
      subtitle: `${range.startTime} – ${range.endTime}`,
      fields: { description },
      editableKeys: ["description"],
      startTime: range.startTime,
      endTime: range.endTime,
    });
  });

  const speechRanges = parseTimeRanges(content, sections.speech, chinese ? "语音转录" : "Speech Transcript");
  if (speechRanges.length === 0) {
    const description = trimRange(content, sections.speech.start, sections.speech.end);
    if (!description.value) throw new Error(`${chinese ? "语音转录" : "Speech Transcript"} 不能为空`);
    units.push({
      id: "speech_transcript.0",
      theme: "speech_transcript",
      title: "Speech 1",
      fields: { description },
      editableKeys: ["description"],
    });
  } else {
    speechRanges.forEach((range, index) => {
      const block = { start: range.end, end: speechRanges[index + 1]?.start ?? sections.speech.end };
      units.push({
        id: `speech_transcript.${index}`,
        theme: "speech_transcript",
        title: `Speech ${index + 1}`,
        subtitle: `${range.startTime} – ${range.endTime}`,
        fields: parseInlineLabels(
          content,
          block,
          chinese ? ZH_SPEECH_LABELS : EN_SPEECH_LABELS,
          `${chinese ? "语音转录" : "Speech Transcript"} 第 ${index + 1} 条`,
        ),
        editableKeys: ["speaker", "state", "content"],
        startTime: range.startTime,
        endTime: range.endTime,
      });
    });
  }
  return units;
}

function pairUnits(document: VideoDocument) {
  const english = parseCaption(document.caption_en, false);
  const chinese = parseCaption(document.caption_zh, true);
  const themes: Array<[Theme, string]> = [
    ["overview", "Overview"],
    ["storyline", "Storyline"],
    ["speech_transcript", "Speech Transcript"],
  ];
  for (const [theme, label] of themes) {
    const source = english.filter((unit) => unit.theme === theme);
    const reference = chinese.filter((unit) => unit.theme === theme);
    if (source.length !== reference.length) throw new Error(`${label} 中英文单元数量不一致`);
    source.forEach((unit, index) => {
      const target = reference[index]!;
      if (unit.startTime !== target.startTime || unit.endTime !== target.endTime) {
        throw new Error(`${label} 第 ${index + 1} 条时间范围不一致`);
      }
      if (Object.keys(unit.fields).join("|") !== Object.keys(target.fields).join("|")) {
        throw new Error(`${label} 第 ${index + 1} 条字段映射不一致`);
      }
    });
  }
  return english.map((unit, index) => ({ english: unit, chinese: chinese[index]! }));
}

function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "document"}: ${issue.message}`).join("；");
}

export function parseVideoDocument(content: string): VideoDocument {
  if (content.startsWith("PK\u0003\u0004") || content.includes("word/document.xml")) {
    throw new Error("文件内容不是 JSON，疑似 DOCX");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("文件内容不是有效的 UTF-8 JSON");
  }
  const result = captionDocumentSchema.safeParse(parsed);
  if (!result.success) throw new Error(formatZodError(result.error));
  const document = result.data as VideoDocument;
  pairUnits(document);
  return document;
}

export function buildAnnotationUnits(document: VideoDocument): AnnotationUnit[] {
  return pairUnits(document).map(({ english, chinese }) => ({
    id: english.id,
    theme: english.theme,
    title: english.title,
    subtitle: english.subtitle,
    sourceFields: Object.fromEntries(Object.entries(english.fields).map(([key, span]) => [key, span.value])),
    referenceFields: Object.fromEntries(Object.entries(chinese.fields).map(([key, span]) => [key, span.value])),
    editableKeys: english.editableKeys,
    startTime: english.startTime,
    endTime: english.endTime,
  }));
}

export function validateCorrection(
  decision: Exclude<Decision, "pending">,
  sourceFields: Record<string, string>,
  correctedFields: Record<string, string>,
): boolean {
  if (decision !== "false") return true;
  return Object.keys(sourceFields).some((key) => (correctedFields[key] ?? "") !== (sourceFields[key] ?? ""));
}

export function applyAnnotations(
  document: VideoDocument,
  records: Record<string, AnnotationRecord>,
): VideoDocument {
  const output = structuredClone(document);
  const replacements: Array<TextRange & { value: string }> = [];
  for (const { english } of pairUnits(document)) {
    const record = records[english.id];
    if (record?.decision !== "false") continue;
    for (const key of english.editableKeys) {
      const span = english.fields[key];
      const value = record.correctedFields[key];
      if (span && value !== undefined) replacements.push({ start: span.start, end: span.end, value });
    }
  }
  replacements.sort((left, right) => right.start - left.start);
  output.caption_en = replacements.reduce(
    (caption, replacement) => caption.slice(0, replacement.start) + replacement.value + caption.slice(replacement.end),
    document.caption_en,
  );
  return output;
}

export function createAnnotationMeta(
  taskId: string,
  annotatorId: string,
  sourceSha256: string,
  document: VideoDocument,
  records: Record<string, AnnotationRecord>,
  exportedAt = new Date().toISOString(),
): AnnotationMeta {
  const units = buildAnnotationUnits(document);
  const counts = { total: units.length, pending: 0, true: 0, false: 0, question: 0, other: 0 };
  const auditUnits = units.map((unit) => {
    const record = records[unit.id];
    const decision: Decision = record?.decision ?? "pending";
    counts[decision] += 1;
    return {
      unit_id: unit.id,
      theme: unit.theme,
      decision,
      source_fields: unit.sourceFields,
      corrected_fields: record?.decision === "false" ? record.correctedFields : unit.sourceFields,
      updated_at: record?.updatedAt ?? null,
    };
  });
  return {
    schema_version: "2.2",
    task_id: taskId,
    annotator_id: annotatorId,
    source_sha256: sourceSha256,
    export_status: counts.pending > 0 ? "partial" : "complete",
    exported_at: exportedAt,
    counts,
    units: auditUnits,
  };
}
