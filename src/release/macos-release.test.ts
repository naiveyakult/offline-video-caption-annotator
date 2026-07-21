import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("macOS v0.5.0 libmpv release contract", () => {
  it("builds the release source and its pinned patched LGPL libmpv runtime", () => {
    const workflow = read(".github/workflows/macos-release.yml");
    const buildScript = read("scripts/macos/build-libmpv.sh");

    expect(workflow).toContain("macos-14");
    expect(workflow).toContain('tags: ["v0.5.0"]');
    expect(workflow).toContain("ref: v0.5.0");
    expect(workflow).toContain("scripts/macos/build-libmpv.sh");
    expect(workflow).toContain("scripts/macos/libmpv-runtime.json");
    expect(workflow).toContain("scripts/macos/patches/mpv-0.41.0-coreaudio-utils.patch");
    expect(workflow).toContain("scripts/macos/check-libmpv-dlopen.py");
    expect(buildScript).toContain("mpv-0.41.0-coreaudio-utils.patch");
    expect(buildScript).toContain("check-libmpv-dlopen.py");
    expect(workflow).toContain("Smoke-test synthetic AAC PCE audio");
    expect(workflow).toContain("-aac_pce 1");
    expect(workflow).toContain("scripts/macos/smoke-libmpv.sh");
    expect(workflow).toContain("npm run rust:setup");
    expect(workflow).toContain("npm run test:run");
    expect(workflow).toContain("npm run lint");
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).toContain("cargo test --manifest-path src-tauri/Cargo.toml");
    expect(workflow).toContain("cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings");
    expect(workflow).toContain("cargo fmt --manifest-path src-tauri/Cargo.toml -- --check");
    expect(workflow).toContain("npm run tauri:build -- --config src-tauri/tauri.mpv-preview.conf.json");
  });

  it("verifies bundled dylibs and uploads a public macOS release", () => {
    const workflow = read(".github/workflows/macos-release.yml");
    const readme = read("README.md");

    expect(workflow).toContain("offline-video-caption-annotator_0.5.0_macos_aarch64.dmg");
    expect(workflow).toContain("offline-video-caption-annotator_0.5.0_macos_aarch64.dmg.sha256");
    expect(workflow).toContain("hdiutil verify");
    expect(workflow).toContain("otool -L");
    expect(workflow).toContain("Contents/Frameworks/libmpv.2.dylib");
    expect(workflow).toContain("@rpath/libmpv.2.dylib");
    expect(workflow).toContain("codesign --verify --deep --strict");
    expect(workflow).toContain("lipo -archs");
    expect(workflow).toContain("CFBundleShortVersionString");
    expect(workflow).toContain("gh release upload");
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain("|| true");
    expect(workflow).toContain("RELEASE_TAG: v0.5.0");
    expect(workflow).not.toContain("--prerelease");
    expect(workflow).toContain('gh release upload "${RELEASE_TAG}"');
    expect(workflow).toContain("--clobber");
    expect(workflow).not.toContain("windows_x64_portable");
    expect(readme).toContain("offline-video-caption-annotator_0.5.0_macos_aarch64.dmg");
    expect(read("THIRD_PARTY_NOTICES.txt")).toContain("mpv 0.41.0");
  });

  it("runs for the formal tag and remains manually rerunnable", () => {
    const workflow = read(".github/workflows/macos-release.yml");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain('tags: ["v0.5.0"]');
    expect(workflow).not.toContain("branches: [main]");
  });

  it("preserves the first real dlopen error and only tries the alias when needed", () => {
    const bridge = read("src-tauri/native/macos/mpv_bridge.m");

    expect(bridge).toContain('stringByAppendingPathComponent:@"libmpv.2.dylib"');
    expect(bridge).toContain("fileExistsAtPath");
    expect(bridge).toContain("libmpv.2.dylib 加载失败");
    expect(bridge).toContain('stringByAppendingPathComponent:@"libmpv.dylib"');
  });
});
