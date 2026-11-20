#!/usr/bin/env python3
"""Package the reviewable source snapshot and generated Safari resources, never local settings."""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--ios-sdk-build-verified", action="store_true",
                    help="Record a successful iOS SDK build of this source; does not run a build.")
parser.add_argument("--simulator-launch-verified", action="store_true",
                    help="Record a successful simulator launch of this source; does not run a simulator.")
parser.add_argument("--ipad-simulator-launch-verified", action="store_true",
                    help="Record a successful iPad simulator launch; does not verify a physical iPad.")
args = parser.parse_args()
if (args.simulator_launch_verified or args.ipad_simulator_launch_verified) and not args.ios_sdk_build_verified:
    parser.error("simulator launch verification also requires iOS SDK build verification")

root = Path(__file__).resolve().parents[3]
output = root / "artifacts" / "ios"
output.mkdir(parents=True, exist_ok=True)
paths = subprocess.check_output(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root
).decode().split("\0")
allowed_roots = {"apps", "packages", "services", "tests", "docs"}
allowed_root_files = {"AGENTS.md", "README.md", ".gitignore", ".env.example", "package.json",
                      "pnpm-lock.yaml", "pnpm-workspace.yaml", "eslint.config.mjs",
                      "tsconfig.json", "tsconfig.base.json", "vitest.config.ts"}
files = set()
for relative in filter(None, paths):
    parts = Path(relative).parts
    if parts[0] not in allowed_roots and relative not in allowed_root_files:
        continue
    if any(part in {"node_modules", ".build", ".swiftpm", "DerivedData", "xcuserdata", ".git"} for part in parts):
        continue
    if Path(relative).name == "Local.xcconfig" or Path(relative).suffix in {".sqlite", ".db", ".log", ".mobileprovision", ".p12"}:
        raise SystemExit("PRIVATE_FILE_REJECTED")
    path = root / relative
    if path.is_symlink():
        raise SystemExit("SYMLINK_REJECTED")
    if path.is_file():
        files.add(relative)
for path in (root / "apps/ios-safari/dist").iterdir():
    if not path.is_file() or path.suffix not in {".js", ".html", ".css", ".json"}:
        raise SystemExit("UNEXPECTED_WEB_RESOURCE")
    files.add(str(path.relative_to(root)))
manifest = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in sorted(files)}
archive = output / "qb-ios-safari-source-v0.1.0.zip"
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as package:
    for name in sorted(files):
        package.write(root / name, "qb-ios-safari/" + name)
    package.writestr("qb-ios-safari/SOURCE_SHA256.json", json.dumps(manifest, indent=2) + "\n")
with zipfile.ZipFile(archive) as package:
    if package.testzip() is not None:
        raise SystemExit("ARCHIVE_INTEGRITY_FAILED")
    for name, expected in manifest.items():
        if hashlib.sha256(package.read("qb-ios-safari/" + name)).hexdigest() != expected:
            raise SystemExit("ARCHIVE_CONTENT_MISMATCH")
summary = {"archive": archive.name, "source_file_count": len(files),
           "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
           "kind": "source-and-web-resources", "signed_ipa": False,
           "ios_sdk_build_verified": args.ios_sdk_build_verified,
           "simulator_launch_verified": args.simulator_launch_verified or args.ipad_simulator_launch_verified,
           "ipad_simulator_launch_verified": args.ipad_simulator_launch_verified,
           "validation_report": "docs/IOS_SAFARI_VALIDATION.md",
           "iphone_verified": False, "ipad_verified": False, "production_notion_verified": False}
(output / "package-manifest.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
