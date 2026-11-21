#!/bin/bash
# Wraps the Dusk web extension in a tiny macOS app so Safari can load it.
# Needs Xcode (free from the App Store). Run from the repo folder:
#
#   ./build-mac.sh                 create the Xcode project and open it
#   TEAM=ABCDE12345 ./build-mac.sh also build, sign with that team and launch
#
# Find your team ID in Xcode > Settings > Accounts, or run:
#   security find-identity -v -p codesigning
set -euo pipefail
cd "$(dirname "$0")"

BUNDLE_ID="local.dusk.darkmode"

if ! xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  echo "Xcode is missing. Install it from the App Store, open it once, then run:"
  echo "  sudo xcode-select -s /Applications/Xcode.app"
  exit 1
fi

rm -rf xcode
xcrun safari-web-extension-converter extension \
  --project-location xcode \
  --app-name Dusk \
  --bundle-identifier "$BUNDLE_ID" \
  --swift --macos-only --copy-resources --no-open --force

# Some converter versions give the app a different ID from the one passed in
# (for example local.dusk.Dusk), and Xcode then refuses to build:
# "Embedded binary's bundle identifier is not prefixed with the parent app's".
# Set the app to BUNDLE_ID and the extension to BUNDLE_ID.Extension.
PROJECT="xcode/Dusk/Dusk.xcodeproj"
while IFS= read -r file; do
  BUNDLE_ID="$BUNDLE_ID" perl -pi -e '
    s{(PRODUCT_BUNDLE_IDENTIFIER"?\s*[=:]\s*"?)([A-Za-z0-9.\-]+)}{
      my ($key, $id) = ($1, $2);
      $key . ($id =~ /\.Extension$/ ? "$ENV{BUNDLE_ID}.Extension" : $ENV{BUNDLE_ID})
    }ge' "$file"
done < <(grep -rl PRODUCT_BUNDLE_IDENTIFIER "$PROJECT")
grep -rl 'extensionBundleIdentifier' xcode/Dusk --include='*.swift' | while IFS= read -r file; do
  BUNDLE_ID="$BUNDLE_ID" perl -pi -e \
    's{(extensionBundleIdentifier\s*=\s*")[^"]*(")}{$1$ENV{BUNDLE_ID}.Extension$2}' "$file"
done

echo
echo "Project created at $PROJECT"

if [ -z "${TEAM:-}" ]; then
  echo "Opening it in Xcode. Next: pick your Apple ID team under Signing, then press Cmd+R."
  echo "Or skip Xcode next time: TEAM=<your team ID> ./build-mac.sh"
  open "$PROJECT"
  exit 0
fi

echo "Building and signing with team $TEAM..."
xcodebuild -project "$PROJECT" -scheme Dusk -configuration Release \
  -derivedDataPath xcode/build \
  DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates -quiet build

APP="xcode/build/Build/Products/Release/Dusk.app"
pkill -x Dusk 2>/dev/null || true
open "$APP"
echo
echo "Built and launched $APP"
echo "Safari loads the extension from that app, so leave it there."
echo "Next: Safari > Settings > Extensions, tick Dusk."
