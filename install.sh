#!/bin/bash
# Installation script for opencode-fff-search plugin
# This script installs the plugin globally for OpenCode
# Works on Linux and macOS. For Windows, use WSL or manual installation.

set -e

echo "Installing opencode-fff-search plugin..."

# Determine install location
# Priority: $OPCODE_PLUGIN_DIR > $OPENCODE_CONFIG_DIR > defaults
if [ -n "$OPCODE_PLUGIN_DIR" ]; then
    INSTALL_DIR="$OPCODE_PLUGIN_DIR"
elif [ -n "$OPENCODE_CONFIG_DIR" ]; then
    INSTALL_DIR="$OPENCODE_CONFIG_DIR/plugins"
elif [ -d "$HOME/.config/opencode" ]; then
    INSTALL_DIR="$HOME/.config/opencode/plugins"
else
    INSTALL_DIR="$HOME/.opencode/plugins"
fi

PLUGIN_NAME="opencode-fff-search.js"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing to: $INSTALL_DIR"

# Create plugins directory if it doesn't exist
mkdir -p "$INSTALL_DIR"

# Copy plugin file
cp "$SCRIPT_DIR/index.js" "$INSTALL_DIR/$PLUGIN_NAME"

echo "✓ Plugin installed to $INSTALL_DIR/$PLUGIN_NAME"

# Install dependencies
echo "Installing dependencies..."
CONFIG_DIR="$(dirname "$INSTALL_DIR")"
cd "$CONFIG_DIR" || exit 1

if command -v bun &> /dev/null; then
    echo "Using Bun to install dependencies..."
    bun add @ff-labs/fff-node
elif command -v npm &> /dev/null; then
    echo "Using npm to install dependencies..."
    npm install @ff-labs/fff-node
else
    echo "Error: Neither Bun nor npm found. Please install Node.js (https://nodejs.org) or Bun (https://bun.sh)."
    exit 1
fi

echo ""
echo "✓ Installation complete!"
echo ""
echo "Next steps:"
echo "1. Restart OpenCode"
echo "2. Verify by running: opencode run 'Search for test using grep'"
echo ""
echo "Note: The fff binary will be downloaded automatically on first use."
echo "If you encounter issues, see: https://github.com/dmtrKovalenko/fff.nvim"
echo ""
echo "On Windows, use WSL or install manually (see README.md)."

