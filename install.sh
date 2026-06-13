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

  echo "Installing dependencies in $CONFIG_DIR..."
  cd "$CONFIG_DIR" || exit 1

  if command -v bun &> /dev/null; then
    echo "  Using Bun..."
    bun add @ff-labs/fff-node @ff-labs/fff-bun minimatch @opencode-ai/plugin
  elif command -v npm &> /dev/null; then
    echo "  Using npm..."
    npm install @ff-labs/fff-node @ff-labs/fff-bun minimatch @opencode-ai/plugin
  else
    echo "Error: Neither Bun nor npm found."
    exit 1
  fi

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

  echo "Installing dependencies in $CONFIG_DIR..."
  cd "$CONFIG_DIR" || exit 1

  if command -v bun &> /dev/null; then
    echo "  Using Bun..."
    bun add @ff-labs/fff-node @ff-labs/fff-bun minimatch @mimo-ai/plugin
  elif command -v npm &> /dev/null; then
    echo "  Using npm..."
    npm install @ff-labs/fff-node @ff-labs/fff-bun minimatch @mimo-ai/plugin
  else
    echo "Error: Neither Bun nor npm found."
    exit 1
  fi

  echo ""
  echo "Done! Restart MiMo Code and verify:"
  echo "  mimo run 'Search for test using grep'"
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
