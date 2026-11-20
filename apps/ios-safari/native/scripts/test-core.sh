#!/bin/sh
# Xcode and Command Line Tools both work; the latter needs its bundled Testing framework explicitly.
set -eu
native_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
developer_dir=$(xcode-select -p)
if [ -d "$developer_dir/Library/Developer/Frameworks/Testing.framework" ]; then
  frameworks="$developer_dir/Library/Developer/Frameworks"
  exec swift test --package-path "$native_dir" --build-system native --disable-xctest \
    -Xswiftc -F -Xswiftc "$frameworks" -Xlinker -F -Xlinker "$frameworks" \
    -Xlinker -rpath -Xlinker "$frameworks" "$@"
fi
exec swift test --package-path "$native_dir" --disable-xctest "$@"
