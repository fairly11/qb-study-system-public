import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];
const licenseMessage = "You have not agreed to the Xcode license agreements.";
const fakeXcodebuild = `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$PREFLIGHT_CALL_LOG"
case "$*" in
  '-version')
    case "$PREFLIGHT_SCENARIO" in
      no-xcode) exit 1 ;;
      version-license) printf '%s\\n' "$PREFLIGHT_LICENSE_MESSAGE" >&2; exit 69 ;;
    esac
    printf 'Xcode 27.1\\nBuild version synthetic\\n'
    ;;
  '-license check')
    case "$PREFLIGHT_SCENARIO" in
      license) printf '%s\\n' "$PREFLIGHT_LICENSE_MESSAGE" >&2; exit 69 ;;
      license-check-error) exit 70 ;;
    esac
    ;;
  '-checkFirstLaunchStatus')
    if [ "$PREFLIGHT_SCENARIO" = first-launch ]; then exit 69; fi
    ;;
  '-version -sdk iphonesimulator Path')
    case "$PREFLIGHT_SCENARIO" in
      sdk-error) exit 1 ;;
      sdk-empty) exit 0 ;;
      sdk-missing-directory) printf '%s/missing\\n' "$PREFLIGHT_SDK_PATH" ;;
      *) printf '%s\\n' "$PREFLIGHT_SDK_PATH" ;;
    esac
    ;;
  '-project '*)
    printf '%s\\n' "$@" > "$PREFLIGHT_BUILD_ARGS"
    if [ "$PREFLIGHT_SCENARIO" = build-error ]; then exit 65; fi
    ;;
  *) exit 97 ;;
esac
`;

function runPreflight(scenario: string, options: { executable?: boolean; manifest?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "qb ios preflight "));
  fixtures.push(root);
  const packageDir = join(root, "ios safari");
  const scripts = join(packageDir, "scripts");
  const bin = join(root, "bin");
  const sdk = join(root, "iPhone Simulator.sdk");
  for (const directory of [scripts, bin, sdk, join(packageDir, "dist")]) mkdirSync(directory, { recursive: true });
  const script = join(scripts, "check-ios-build.sh");
  copyFileSync(new URL("../scripts/check-ios-build.sh", import.meta.url), script);
  // PATH contains only this fixture. No test can fall through to real Xcode.
  symlinkSync("/usr/bin/dirname", join(bin, "dirname"));
  if (options.executable !== false) {
    const fake = join(bin, "xcodebuild");
    writeFileSync(fake, fakeXcodebuild);
    chmodSync(fake, 0o755);
  }
  if (options.manifest !== false) writeFileSync(join(packageDir, "dist/manifest.json"), "{}");
  const callLog = join(root, "calls.txt");
  const buildArgs = join(root, "build-args.txt");
  const result = spawnSync("/bin/sh", [script], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: bin,
      PREFLIGHT_SCENARIO: scenario,
      PREFLIGHT_CALL_LOG: callLog,
      PREFLIGHT_BUILD_ARGS: buildArgs,
      PREFLIGHT_SDK_PATH: sdk,
      PREFLIGHT_LICENSE_MESSAGE: licenseMessage,
    },
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stderr: result.stderr,
    calls: existsSync(callLog) ? readFileSync(callLog, "utf8").trim().split("\n") : [],
    buildArgs: existsSync(buildArgs) ? readFileSync(buildArgs, "utf8").trim().split("\n") : [],
    packageDir,
  };
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("iOS build preflight", () => {
  it("stops when no xcodebuild executable exists", () => {
    const result = runPreflight("ready", { executable: false });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("IOS_BUILD_UNAVAILABLE:");
    expect(result.calls).toEqual([]);
  });

  it("distinguishes an unavailable full Xcode from setup requirements", () => {
    const result = runPreflight("no-xcode");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("IOS_BUILD_UNAVAILABLE:");
    expect(result.calls).toEqual(["-version"]);
  });

  it("recognizes license rejection even when the version query fails", () => {
    const result = runPreflight("version-license");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("XCODE_LICENSE_REQUIRED:");
    expect(result.calls).toEqual(["-version"]);
  });

  it("checks the license despite a successful version query and stops before setup or build", () => {
    const result = runPreflight("license");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("XCODE_LICENSE_REQUIRED:");
    expect(result.calls).toEqual(["-version", "-license check"]);
    expect(result.buildArgs).toEqual([]);
  });

  it("does not diagnose an unknown license-check failure as missing consent", () => {
    const result = runPreflight("license-check-error");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("XCODE_PREFLIGHT_FAILED:");
    expect(result.stderr).not.toContain("XCODE_LICENSE_REQUIRED:");
    expect(result.calls).toEqual(["-version", "-license check"]);
  });

  it("reports incomplete first-launch preparation without running it", () => {
    const result = runPreflight("first-launch");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("XCODE_FIRST_LAUNCH_REQUIRED:");
    expect(result.calls).toEqual(["-version", "-license check", "-checkFirstLaunchStatus"]);
    expect(result.buildArgs).toEqual([]);
  });

  it.each(["sdk-error", "sdk-empty", "sdk-missing-directory"])("stops before build for unavailable Simulator SDK: %s", (scenario) => {
    const result = runPreflight(scenario);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("IOS_SIMULATOR_SDK_MISSING:");
    expect(result.calls).toEqual(["-version", "-license check", "-checkFirstLaunchStatus", "-version -sdk iphonesimulator Path"]);
    expect(result.buildArgs).toEqual([]);
  });

  it("reports missing generated web resources after Xcode is ready", () => {
    const result = runPreflight("ready", { manifest: false });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("WEB_BUILD_MISSING:");
    expect(result.buildArgs).toEqual([]);
    expect(result.calls).toHaveLength(4);
  });

  it("builds without signing only after all checks, preserving paths containing spaces", () => {
    const result = runPreflight("ready");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.calls.slice(0, 4)).toEqual(["-version", "-license check", "-checkFirstLaunchStatus", "-version -sdk iphonesimulator Path"]);
    expect(result.calls).toHaveLength(5);
    expect(result.buildArgs).toEqual([
      "-project", join(result.packageDir, "ios/QBRecord.xcodeproj"), "-scheme", "QBRecord",
      "-configuration", "Debug", "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator",
      "-derivedDataPath", join(result.packageDir, "ios/DerivedData"), "CODE_SIGNING_ALLOWED=NO", "build",
    ]);
  });

  it("preserves a real build failure after successful preflight", () => {
    const result = runPreflight("build-error");
    expect(result.status).toBe(65);
    expect(result.buildArgs.at(-1)).toBe("build");
  });
});
