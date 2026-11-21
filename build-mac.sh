#!/bin/bash
# Wraps the Dusk web extension in a tiny macOS app so Safari can load it.
# Needs Xcode (free from the App Store). Run from the repo folder: ./build-mac.sh
set -euo pipefail
cd "$(dirname "$0")"

if ! xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  echo "Xcode is missing. Install it from the App Store, open it once, then run:"
  echo "  sudo xcode-select -s /Applications/Xcode.app"
  exit 1
fi

rm -rf xcode
xcrun safari-web-extension-converter extension \
  --project-location xcode \
  --app-name Dusk \
  --bundle-identifier local.dusk.darkmode \
  --swift --macos-only --copy-resources --no-open --force

echo
echo "Project created at xcode/Dusk/Dusk.xcodeproj"
echo "Opening it in Xcode. Next: pick your Apple ID team under Signing, then press Cmd+R."
open xcode/Dusk/Dusk.xcodeproj
