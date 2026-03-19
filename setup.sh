#!/usr/bin/env bash
set -euo pipefail

PI_REPO="$(cd "$(dirname "$0")" && pwd)"
PI_AGENT="$HOME/.pi/agent"

mkdir -p "$PI_AGENT"

symlink() {
  local src="$1" dst="$2" name="$3"

  if [ -L "$dst" ]; then
    local current
    current="$(readlink "$dst")"
    if [ "$current" = "$src" ]; then
      echo "  ✓ $name (already linked)"
      return
    fi
    echo "  → $name (updating link)"
    rm "$dst"
  elif [ -e "$dst" ]; then
    echo "  → $name (backing up existing to ${dst}.bak)"
    mv "$dst" "${dst}.bak"
  else
    echo "  + $name"
  fi

  ln -s "$src" "$dst"
}

echo "Linking pi config from $PI_REPO → $PI_AGENT"
echo ""

symlink "$PI_REPO/settings.json"    "$PI_AGENT/settings.json"    "settings.json"
symlink "$PI_REPO/permissions.json"  "$PI_AGENT/permissions.json"  "permissions.json"
symlink "$PI_REPO/keybindings.json"  "$PI_AGENT/keybindings.json"  "keybindings.json"
symlink "$PI_REPO/cvr-pi.json"       "$PI_AGENT/cvr-pi.json"       "cvr-pi.json"

if [ -d "$PI_REPO/skills" ]; then
  symlink "$PI_REPO/skills" "$PI_AGENT/skills" "skills/"
elif [ -L "$PI_AGENT/skills" ]; then
  echo "  → skills/ (removing stale link)"
  rm "$PI_AGENT/skills"
fi

echo ""
echo "Done. Preserved: auth.json, sessions/"
echo ""
echo "Install deps:  cd $PI_REPO && bun install"
