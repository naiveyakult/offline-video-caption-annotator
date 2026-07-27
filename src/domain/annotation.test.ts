import { describe, expect, it } from "vitest";
import {
  applyAnnotations,
  buildAnnotationUnits,
  createAnnotationMeta,
  parseVideoDocument,
} from "./annotation";
import type { AnnotationRecord } from "./types";
import { captionFixture, noSpeechFixture } from "../test/caption-fixture";

describe("bilingual caption annotation domain", () => {
  it("parses paired captions and creates no Visible Text units", () => {
    const document = parseVideoDocument(JSON.stringify(captionFixture));
    const units = buildAnnotationUnits(document);

    expect(units).toHaveLength(9);
    expect(units.map((unit) => unit.id)).toEqual([
      "overview.overall_visual_style",
      "overview.overall_audio_style",
      "overview.character_profiles.0",
      "overview.character_profiles.1",
      "overview.narrative_theme",
      "storyline.0",
      "storyline.1",
      "speech_transcript.0",
      "speech_transcript.1",
    ]);
    expect(units[0]?.sourceFields).toEqual({ overall_visual_style: "Cinematic natural light." });
    expect(units[0]?.referenceFields).toEqual({ overall_visual_style: "电影化的自然光。" });
    expect(units[7]?.sourceFields).toEqual({ speaker: "Alice", state: "calm", content: '"Wait here."' });
    expect(units[7]?.referenceFields).toEqual({ speaker: "Alice", state: "平静", content: '"Wait here."' });
    expect(units.some((unit) => unit.id.startsWith("visible_text"))).toBe(false);
  });

  it("creates one untimed Speech Transcript unit for a no-speech statement", () => {
    const units = buildAnnotationUnits(parseVideoDocument(JSON.stringify(noSpeechFixture)));
    const speech = units.filter((unit) => unit.theme === "speech_transcript");

    expect(speech).toHaveLength(1);
    expect(speech[0]?.sourceFields).toEqual({ description: "No audible speech is present in the video." });
    expect(speech[0]?.referenceFields).toEqual({ description: "视频中没有可闻的语音。" });
    expect(speech[0]?.startTime).toBeUndefined();
  });

  it("rejects legacy structured JSON and missing fixed headings", () => {
    expect(() => parseVideoDocument(JSON.stringify({ overview: {}, storyline: [] }))).toThrow("caption_en");
    const missing = { ...captionFixture, caption_zh: captionFixture.caption_zh.replace("## 可见文字", "## 屏幕文字") };
    expect(() => parseVideoDocument(JSON.stringify(missing))).toThrow("缺少固定章节标题：## 可见文字");
  });

  it("rejects mismatched item counts and timestamps", () => {
    const missingStory = {
      ...captionFixture,
      caption_zh: captionFixture.caption_zh.replace(/00:05\.000 - 00:10\.000\nBob 坐在路边。\n\n/, ""),
    };
    expect(() => parseVideoDocument(JSON.stringify(missingStory))).toThrow("Storyline 中英文单元数量不一致");

    const wrongTime = {
      ...captionFixture,
      caption_zh: captionFixture.caption_zh.replace("00:05.000 - 00:10.000", "00:06.000 - 00:10.000"),
    };
    expect(() => parseVideoDocument(JSON.stringify(wrongTime))).toThrow("Storyline 第 2 条时间范围不一致");
  });

  it("never rewrites Caption source data", () => {
    const document = parseVideoDocument(JSON.stringify(captionFixture));
    const records: Record<string, AnnotationRecord> = {
      "storyline.0": {
        unitId: "storyline.0",
        decision: "false",
        correctedFields: { description: "Alice leaves immediately." },
        updatedAt: "2026-07-14T00:00:00.000Z",
      },
    };
    const output = applyAnnotations(document, records);

    expect(output.caption_en).toBe(captionFixture.caption_en);
    expect(output.caption_zh).toBe(captionFixture.caption_zh);
    expect(output._id).toBe(captionFixture._id);
    expect(output.usage).toEqual(captionFixture.usage);
  });

  it("exports schema 3.0 with only actually reviewed units before a False stop", () => {
    const document = parseVideoDocument(JSON.stringify(noSpeechFixture));
    const meta = createAnnotationMeta("task-1", "A023", "hash", document, {
      "overview.overall_visual_style": {
        unitId: "overview.overall_visual_style",
        decision: "true",
        correctedFields: {},
        updatedAt: "2026-07-14T00:00:00.000Z",
      },
      "overview.overall_audio_style": {
        unitId: "overview.overall_audio_style",
        decision: "false",
        correctedFields: {},
        updatedAt: "2026-07-14T00:00:01.000Z",
      },
      "overview.narrative_theme": {
        unitId: "overview.narrative_theme",
        decision: "true",
        correctedFields: {},
        updatedAt: "2026-07-14T00:00:02.000Z",
      },
    }, "2026-07-14T00:00:03.000Z", "overview.overall_audio_style");

    expect(meta.schema_version).toBe("3.0");
    expect(meta.video_decision).toBe("false");
    expect(meta.completion_mode).toBe("false_early_stop");
    expect(meta.stopped_at_unit_id).toBe("overview.overall_audio_style");
    expect(meta.counts).toEqual({ source_total: 8, annotated: 2, true: 1, false: 1, unreviewed: 6 });
    expect(meta.units).toHaveLength(2);
    expect(meta.units.every((unit) => !("reference_fields" in unit))).toBe(true);
    expect(meta.units.every((unit) => !("corrected_fields" in unit))).toBe(true);
  });

  it("exports an all-True task as a completed video", () => {
    const document = parseVideoDocument(JSON.stringify(noSpeechFixture));
    const records = Object.fromEntries(buildAnnotationUnits(document).map((unit, index) => [
      unit.id,
      {
        unitId: unit.id,
        decision: "true" as const,
        correctedFields: {},
        updatedAt: `2026-07-14T00:00:${String(index).padStart(2, "0")}.000Z`,
      },
    ]));

    const meta = createAnnotationMeta("task-1", "A023", "hash", document, records);
    expect(meta.export_status).toBe("complete");
    expect(meta.video_decision).toBe("true");
    expect(meta.completion_mode).toBe("all_units");
    expect(meta.counts).toEqual({ source_total: 8, annotated: 8, true: 8, false: 0, unreviewed: 0 });
  });
});
