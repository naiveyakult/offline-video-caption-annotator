import { beforeEach, describe, expect, it, vi } from "vitest";

const FONT_SIZE_KEY = "video-annotator:annotation-font-size";

async function loadStore() {
  vi.resetModules();
  return (await import("./app-store")).useAppStore;
}

describe("annotation font-size preference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to 14px and persists a valid selection", async () => {
    const useAppStore = await loadStore();

    expect(useAppStore.getState().annotationFontSize).toBe(14);
    useAppStore.getState().setAnnotationFontSize(16);

    expect(useAppStore.getState().annotationFontSize).toBe(16);
    expect(localStorage.getItem(FONT_SIZE_KEY)).toBe("16");
  });

  it("restores valid values and falls back from invalid cached values", async () => {
    localStorage.setItem(FONT_SIZE_KEY, "12");
    let useAppStore = await loadStore();
    expect(useAppStore.getState().annotationFontSize).toBe(12);

    localStorage.setItem(FONT_SIZE_KEY, "99");
    useAppStore = await loadStore();
    expect(useAppStore.getState().annotationFontSize).toBe(14);
  });
});
