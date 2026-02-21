#!/bin/bash
set -e

# Load environment variables from .env
if [ -f .env ]; then
  export $(cat .env | grep -v '^#' | xargs)
fi

# Verify CLI tools are installed
if ! command -v vsce &> /dev/null; then
  echo "❌ Error: vsce is not installed"
  echo "   Run: npm install -g @vscode/vsce"
  exit 1
fi

if ! command -v ovsx &> /dev/null; then
  echo "❌ Error: ovsx is not installed"
  echo "   Run: npm install -g ovsx"
  exit 1
fi

# Verify both tokens are set
if [ -z "$VSCODE_EXTENSIONS_TOKEN" ]; then
  echo "❌ Error: VSCODE_EXTENSIONS_TOKEN is not set"
  echo "   Please add it to your .env file"
  exit 1
fi

if [ -z "$OVSX_TOKEN" ]; then
  echo "❌ Error: OVSX_TOKEN is not set"
  echo "   Please add it to your .env file"
  exit 1
fi

# Get version bump type from argument
BUMP_TYPE=$1

if [ -z "$BUMP_TYPE" ]; then
  echo "Usage: npm run publish:<patch|minor|major>"
  exit 1
fi

echo "🚀 Publishing Codebrief extension..."
echo "   Version bump: $BUMP_TYPE"
echo ""

# Publish to VS Code Marketplace
echo "📦 Publishing to VS Code Marketplace..."
vsce publish $BUMP_TYPE -p $VSCODE_EXTENSIONS_TOKEN

# Publish to Open VSX
echo ""
echo "📦 Publishing to Open VSX (Cursor)..."
ovsx publish -p $OVSX_TOKEN

echo ""
echo "✅ Successfully published to both stores!"
