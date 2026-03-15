#!/usr/bin/env bash
set -euo pipefail

DOTFILES_PI="$(cd "$(dirname "$0")" && pwd)"
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

echo "Linking pi config from $DOTFILES_PI → $PI_AGENT"
echo ""

symlink "$DOTFILES_PI/settings.json"    "$PI_AGENT/settings.json"    "settings.json"
symlink "$DOTFILES_PI/permissions.json"  "$PI_AGENT/permissions.json"  "permissions.json"
symlink "$DOTFILES_PI/keybindings.json"  "$PI_AGENT/keybindings.json"  "keybindings.json"
symlink "$DOTFILES_PI/cvr-pi.json"       "$PI_AGENT/cvr-pi.json"       "cvr-pi.json"

if [ -d "$DOTFILES_PI/skills" ]; then
  symlink "$DOTFILES_PI/skills" "$PI_AGENT/skills" "skills/"
fi

echo ""
echo "Done. Preserved: auth.json, sessions/"
echo ""
echo "Install deps:  cd $DOTFILES_PI && bun install"
