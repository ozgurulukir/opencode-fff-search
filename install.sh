#!/bin/bash
# Installation script for opencode-fff-search plugin
# Supports both OpenCode and MiMo Code targets.
# Works on Linux and macOS. For Windows, use WSL or manual installation.

set -e

TARGET=""
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_FILES=(index.js constants.js helpers.js filters.js gitignore.js search.js)

usage() {
  echo "Usage: $0 --target opencode|mimocode"
  echo ""
  echo "Options:"
  echo "  --target    Target platform: opencode or mimocode (required)"
  echo "  -h, --help  Show this help"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="$2"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown option: $1"
      usage
      ;;
  esac
done

if [ -z "$TARGET" ]; then
  echo "Error: --target is required"
  usage
fi

install_opencode() {
  echo "Installing opencode-fff-search for OpenCode..."

  if [ -n "$OPCODE_PLUGIN_DIR" ]; then
    PLUGINS_DIR="$OPCODE_PLUGIN_DIR"
  elif [ -n "$OPENCODE_CONFIG_DIR" ]; then
    PLUGINS_DIR="$OPENCODE_CONFIG_DIR/plugins"
  elif [ -d "$HOME/.config/opencode" ]; then
    PLUGINS_DIR="$HOME/.config/opencode/plugins"
  else
    PLUGINS_DIR="$HOME/.opencode/plugins"
  fi

  CONFIG_DIR="$(dirname "$PLUGINS_DIR")"
  INSTALL_DIR="$PLUGINS_DIR/opencode-fff-search"

  mkdir -p "$INSTALL_DIR"

  for f in "${PLUGIN_FILES[@]}"; do
    cp -f "$SCRIPT_DIR/$f" "$INSTALL_DIR/$f"
  done

  echo "  Plugin files copied to $INSTALL_DIR"

  ln -sf "opencode-fff-search/index.js" "$PLUGINS_DIR/opencode-fff-search.js"
  echo "  Symlink created: $PLUGINS_DIR/opencode-fff-search.js → opencode-fff-search/index.js"

  install_deps "$CONFIG_DIR" @ff-labs/fff-node @ff-labs/fff-bun minimatch @opencode-ai/plugin

  echo ""
  echo "Done! Restart OpenCode and verify:"
  echo "  opencode run 'Search for test using grep'"
}

install_mimocode() {
  echo "Installing opencode-fff-search for MiMo Code..."

  CONFIG_DIR="$HOME/.config/mimocode"
  INSTALL_DIR="$CONFIG_DIR/plugins/opencode-fff-search"

  mkdir -p "$INSTALL_DIR"

  for f in "${PLUGIN_FILES[@]}"; do
    cp -f "$SCRIPT_DIR/$f" "$INSTALL_DIR/$f"
  done

  echo "  Plugin files copied to $INSTALL_DIR"

  ln -sf "opencode-fff-search/index.js" "$CONFIG_DIR/plugins/opencode-fff-search.js"
  echo "  Symlink created: $CONFIG_DIR/plugins/opencode-fff-search.js → opencode-fff-search/index.js"

  install_deps "$CONFIG_DIR" @ff-labs/fff-node @ff-labs/fff-bun minimatch @mimo-ai/plugin

  echo ""
  echo "Done! Restart MiMo Code and verify:"
  echo "  mimo run 'Search for test using grep'"
}

install_deps() {
  local config_dir="$1"
  shift
  local pkgs=("$@")

  cd "$config_dir" || exit 1

  local all_installed=true
  for pkg in "${pkgs[@]}"; do
    if [ ! -d "node_modules/$pkg" ]; then
      all_installed=false
      break
    fi
  done

  if [ "$all_installed" = true ]; then
    echo "  Dependencies already installed, skipped."
    return
  fi

  echo "Installing dependencies in $config_dir..."
  if command -v bun &> /dev/null; then
    echo "  Using Bun..."
    bun add "${pkgs[@]}"
  elif command -v npm &> /dev/null; then
    echo "  Using npm..."
    npm install "${pkgs[@]}"
  else
    echo "Error: Neither Bun nor npm found."
    exit 1
  fi
}

case "$TARGET" in
  opencode)
    install_opencode
    ;;
  mimocode)
    install_mimocode
    ;;
  *)
    echo "Error: Unknown target '$TARGET'. Use 'opencode' or 'mimocode'."
    exit 1
    ;;
esac
