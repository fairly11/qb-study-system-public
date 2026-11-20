#!/bin/zsh

set -eu

script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

node_command=""
if command -v node >/dev/null 2>&1; then
  node_command="$(command -v node)"
elif [[ -x /opt/homebrew/bin/node ]]; then
  node_command="/opt/homebrew/bin/node"
elif [[ -x /usr/local/bin/node ]]; then
  node_command="/usr/local/bin/node"
fi

if [[ -z "$node_command" ]]; then
  print -u2 -- "ERROR_NODE_24_REQUIRED"
  print -u2 -- "Node.js 24.19.0以上をインストールしてから再実行してください。"
  exit 1
fi

node_compatible="$("$node_command" -p '
  const [major, minor] = process.versions.node.split(".").map(Number);
  major === 24 && minor >= 19 ? "yes" : "no";
')"

if [[ "$node_compatible" != "yes" ]]; then
  print -u2 -- "ERROR_NODE_24_REQUIRED"
  print -u2 -- "検出したNode.js: $("$node_command" --version)。必要: 24.19.0以上、25未満。"
  exit 1
fi

exec "$node_command" "$script_directory/collector/dist/collector.mjs"
