import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("macOS v0.3.0 release contract", () => {
  it("builds the tagged source on an Apple Silicon runner", () => {
    const workflow = read(".github/workflows/macos-release.yml");

    expect(workflow).toContain("macos-14");
    expect(workflow).toContain("ref: v0.3.0");
    expect(workflow).toContain("npm run rust:setup");
    expect(workflow).toContain("npm run test:run");
    expect(workflow).toContain("npm run lint");
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).toContain("cargo test --manifest-path src-tauri/Cargo.toml");
    expect(workflow).toContain("cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings");
    expect(workflow).toContain("cargo fmt --manifest-path src-tauri/Cargo.toml -- --check");
    expect(workflow).toContain("npm run tauri:build -- --config src-tauri/tauri.macos.conf.json");
  });

  it("verifies and uploads only the macOS v0.3.0 assets", () => {
    const workflow = read(".github/workflows/macos-release.yml");

    expect(workflow).toContain("视频剧情标注_0.3.0_aarch64.dmg");
    expect(workflow).toContain("视频剧情标注_0.3.0_aarch64.dmg.sha256");
    expect(workflow).toContain("hdiutil verify");
    expect(workflow).toContain("codesign --verify --deep --strict");
    expect(workflow).toContain("lipo -archs");
    expect(workflow).toContain("CFBundleShortVersionString");
    expect(workflow).toContain("gh release upload");
    expect(workflow).toContain("RELEASE_TAG: v0.3.0");
    expect(workflow).toContain('gh release upload "${RELEASE_TAG}"');
    expect(workflow).toContain("--clobber");
    expect(workflow).not.toContain("windows_x64_portable");
  });

  it("runs once when introduced and remains manually rerunnable", () => {
    const workflow = read(".github/workflows/macos-release.yml");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain('paths: [".github/workflows/macos-release.yml"]');
  });
});
