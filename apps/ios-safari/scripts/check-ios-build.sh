#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PACKAGE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

stop_if_license_required() {
  case "$1" in
    *'You have not agreed to the Xcode license agreements'*)
      echo 'XCODE_LICENSE_REQUIRED: Xcodeのライセンス同意が必要です。利用者がXcodeを開き、規約を確認してください。自動同意は行いません。' >&2
      exit 2
      ;;
  esac
}

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo 'IOS_BUILD_UNAVAILABLE: Xcode本体を利用できません。Xcodeの導入とCommand Line Toolsの選択を確認してください。' >&2
  exit 2
fi
if XCODE_VERSION_OUTPUT=$(LC_ALL=C xcodebuild -version 2>&1); then
  :
else
  stop_if_license_required "$XCODE_VERSION_OUTPUT"
  echo 'IOS_BUILD_UNAVAILABLE: Xcode本体を利用できません。Xcodeの導入とCommand Line Toolsの選択を確認してください。' >&2
  exit 2
fi

# -version can succeed before license acceptance. "check" only reads the state;
# never use -license accept or -runFirstLaunch here (the latter also agrees).
if XCODE_LICENSE_OUTPUT=$(LC_ALL=C xcodebuild -license check </dev/null 2>&1); then
  :
else
  XCODE_LICENSE_STATUS=$?
  stop_if_license_required "$XCODE_LICENSE_OUTPUT"
  echo "XCODE_PREFLIGHT_FAILED: Xcodeのライセンス状態を確認できませんでした（終了コード $XCODE_LICENSE_STATUS）。Xcodeを開いて状態を確認してください。" >&2
  exit 2
fi
if ! LC_ALL=C xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1; then
  echo 'XCODE_FIRST_LAUNCH_REQUIRED: Xcodeの初回準備が完了していません。利用者がXcodeを開き、必要な追加コンポーネントの準備を完了してください。' >&2
  exit 2
fi

# Query the SDK used by the generic simulator build, not installed runtimes.
if IOS_SIMULATOR_SDK_PATH=$(LC_ALL=C xcodebuild -version -sdk iphonesimulator Path 2>/dev/null) &&
    [ -n "$IOS_SIMULATOR_SDK_PATH" ] && [ -d "$IOS_SIMULATOR_SDK_PATH" ]; then
  :
else
  echo 'IOS_SIMULATOR_SDK_MISSING: iOS Simulator向けSDKが見つかりません。XcodeのiOS開発コンポーネントを確認してください。' >&2
  exit 2
fi
if [ ! -f "$PACKAGE_DIR/dist/manifest.json" ]; then
  echo 'WEB_BUILD_MISSING: プロジェクト直下で pnpm build を実行してください。' >&2
  exit 2
fi
xcodebuild -project "$PACKAGE_DIR/ios/QBRecord.xcodeproj" -scheme QBRecord \
  -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$PACKAGE_DIR/ios/DerivedData" CODE_SIGNING_ALLOWED=NO build
