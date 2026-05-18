#!/bin/sh
# Block Read/Edit/Write on sensitive files.
# Receives PreToolUse JSON on stdin; extracts tool_input.file_path.
# Exits 2 with a stderr message when the path matches a sensitive pattern.

input=$(cat)
file_path=$(printf '%s' "$input" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

[ -z "$file_path" ] && exit 0

base=$(basename "$file_path")
lower=$(printf '%s' "$file_path" | tr '[:upper:]' '[:lower:]')

blocked=0
case "$base" in
  .env|.env.*|id_rsa|id_ed25519|.npmrc|.pypirc|.netrc) blocked=1 ;;
esac
case "$lower" in
  *.pem|*.key) blocked=1 ;;
esac
case "$lower" in
  *credentials*|*secrets*) blocked=1 ;;
esac

if [ "$blocked" -eq 1 ]; then
  printf 'Blocked: %s matches a sensitive file pattern. If you need to know what'\''s in this file, ask the user.\n' "$file_path" >&2
  exit 2
fi

exit 0
