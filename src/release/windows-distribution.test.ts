import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(read(relativePath)) as Record<string, unknown>;
}

describe("Windows portable distribution contract", () => {
  it("keeps shared, macOS, and Windows Tauri settings separated", () => {
    const shared = readJson("src-tauri/tauri.conf.json") as {
      version: string;
      app: { security: { assetProtocol: { scope: string[] } } };
    };
    const mac = readJson("src-tauri/tauri.macos.conf.json") as {
      bundle: { targets: string[]; macOS: { minimumSystemVersion: string } };
    };
    const windows = readJson("src-tauri/tauri.windows.conf.json") as {
      bundle: {
        icon: string[];
        windows: {
          webviewInstallMode: { type: string; path: string };
        };
      };
    };

    expect(shared.version).toBe("0.3.0");
    expect(shared.app.security.assetProtocol.scope).toEqual([]);
    expect(mac.bundle.targets).toEqual(["dmg", "app"]);
    expect(mac.bundle.macOS.minimumSystemVersion).toBe("13.0");
    expect(windows.bundle.icon).toContain("icons/icon.ico");
    expect(windows.bundle.windows.webviewInstallMode).toEqual({
      type: "fixedRuntime",
      path: "./WebView2FixedRuntime",
    });
  });

  it("ships a no-admin launcher with WebView2 ACL and location guards", () => {
    const launcher = read("scripts/windows/启动视频剧情标注.cmd");

    expect(launcher).toContain("*S-1-15-2-1");
    expect(launcher).toContain("*S-1-15-2-2");
    expect(launcher).toContain("icacls");
    expect(launcher).toContain("WebView2FixedRuntime");
    expect(launcher).toContain("视频剧情标注.exe");
    expect(launcher).toMatch(/UNC|网络/);
  });

  it("builds and publishes a pinned Windows x64 portable artifact", () => {
    const workflow = read(".github/workflows/windows-portable.yml");
    const runtime = readJson("scripts/windows/webview2-runtime.json") as {
      version: string;
      architecture: string;
      url: string;
      sha256: string;
    };

    expect(workflow).toContain("windows-2022");
    expect(workflow).toContain("retention-days: 7");
    expect(workflow).toContain("--no-bundle");
    expect(workflow).toContain("STATIC_VCRUNTIME");
    expect(workflow).toContain("git rev-list --objects --all");
    expect(workflow).toContain("$global:LASTEXITCODE = 0");
    expect(workflow).toContain("release:");
    expect(runtime.version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(runtime.architecture).toBe("x64");
    expect(runtime.url).toMatch(/^https:\/\/.*microsoft\.com\//);
    expect(runtime.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps private datasets and generated state out of the public repository", () => {
    const ignore = read(".gitignore");
    const readme = read("README.md");

    expect(ignore).toContain("*.mp4");
    expect(ignore).toContain("*.jsonl");
    expect(ignore).toContain("movie.zip");
    expect(ignore).toContain("WebView2FixedRuntime/");
    expect(readme).toContain("scenes_batch_final_caption_zh.jsonl");
    expect(readme).toContain("media-batch/");
  });
});
