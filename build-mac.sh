#!/bin/bash
# Wraps the Dusk web extension in a tiny macOS app so Safari can load it.
# Needs Xcode (free from the App Store). Run from the repo folder:
#
#   ./build-mac.sh                 create the Xcode project and open it
#   TEAM=ABCDE12345 ./build-mac.sh also build, sign with that team and launch
#
# Find your team ID in Xcode > Settings > Accounts, or run ./build-mac.sh --teams
# (the code in brackets from `security find-identity` is NOT the team ID).
set -euo pipefail
cd "$(dirname "$0")"

BUNDLE_ID="local.dusk.darkmode"
MIN_MACOS="12.0"

# Team IDs of the Apple Development certificates in your keychain. The team ID
# is the certificate's organizational unit (OU).
list_teams() {
  local dir pem
  dir=$(mktemp -d)
  security find-certificate -a -c "Apple Development" -p 2>/dev/null |
    awk -v d="$dir" '/BEGIN CERTIFICATE/{n++} n{print > (d "/" n ".pem")}'
  for pem in "$dir"/*.pem; do
    [ -e "$pem" ] || continue
    openssl x509 -in "$pem" -noout -subject -nameopt multiline 2>/dev/null |
      awk -F' = ' '/organizationalUnitName/{ou=$2} /organizationName/{o=$2} END{if (ou) print "  " ou "  (" o ")"}'
  done | sort -u
  rm -rf "$dir"
}

if [ "${1:-}" = "--teams" ]; then
  echo "Team IDs you can pass as TEAM=...:"
  list_teams
  exit 0
fi

if [ -n "${TEAM:-}" ] && ! [[ "$TEAM" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "TEAM must be a 10-character team ID like ABCDE12345, not \"$TEAM\"."
  echo "Team IDs found in your keychain:"
  list_teams
  exit 1
fi

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
# Only whole literal values are replaced; values built from $(VARIABLES) are left alone.
#
# The converter also sets the deployment target to the macOS it runs on, so
# the app would refuse to launch on any older Mac. Pin every target to MIN_MACOS.
PROJECT="xcode/Dusk/Dusk.xcodeproj"
while IFS= read -r file; do
  BUNDLE_ID="$BUNDLE_ID" MIN_MACOS="$MIN_MACOS" perl -pi -e '
    s{(PRODUCT_BUNDLE_IDENTIFIER"?\s*[=:]\s*"?)([A-Za-z0-9.\-]+)(?=[";,\s]|$)}{
      my ($key, $id) = ($1, $2);
      $key . ($id =~ /\.Extension$/ ? "$ENV{BUNDLE_ID}.Extension" : $ENV{BUNDLE_ID})
    }ge;
    s{(MACOSX_DEPLOYMENT_TARGET"?\s*[=:]\s*"?)[0-9.]+(?=[";,\s]|$)}{$1$ENV{MIN_MACOS}}g;
  ' "$file"
done < <(grep -rlE 'PRODUCT_BUNDLE_IDENTIFIER|MACOSX_DEPLOYMENT_TARGET' "$PROJECT")
while IFS= read -r file; do
  BUNDLE_ID="$BUNDLE_ID" perl -pi -e \
    's{(extensionBundleIdentifier\s*=\s*")[^"]*(")}{$1$ENV{BUNDLE_ID}.Extension$2}' "$file"
done < <(grep -rl 'extensionBundleIdentifier' xcode/Dusk --include='*.swift' || true)

if ! grep -rqE "PRODUCT_BUNDLE_IDENTIFIER\"?[[:space:]]*[=:][[:space:]]*\"?$BUNDLE_ID\"?[;,]" "$PROJECT" ||
   ! grep -rqE "PRODUCT_BUNDLE_IDENTIFIER\"?[[:space:]]*[=:][[:space:]]*\"?$BUNDLE_ID\.Extension\"?[;,]" "$PROJECT"; then
  echo "Could not set the bundle IDs in $PROJECT to $BUNDLE_ID and $BUNDLE_ID.Extension."
  echo "Open the project in Xcode and set them by hand under each target's Signing & Capabilities."
  exit 1
fi

echo
echo "Project created at $PROJECT"

if [ -z "${TEAM:-}" ]; then
  echo "Opening it in Xcode. Next: pick your Apple ID team under Signing, then press Cmd+R."
  echo "Or skip Xcode next time: TEAM=<your team ID> ./build-mac.sh"
  open "$PROJECT"
  exit 0
fi

echo "Building and signing with team $TEAM..."
if ! xcodebuild -project "$PROJECT" -scheme Dusk -configuration Release \
  -derivedDataPath xcode/build \
  DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates -quiet build; then
  echo
  echo "Build failed. If the errors above mention signing, check that $TEAM is your team ID"
  echo "and that your Apple ID is signed in under Xcode > Settings > Accounts."
  echo "Team IDs found in your keychain:"
  list_teams
  exit 1
fi

APP="xcode/build/Build/Products/Release/Dusk.app"
pkill -x Dusk 2>/dev/null || true
open "$APP"
echo
echo "Built and launched $APP"
echo "Safari loads the extension from that app, so leave it there."
echo "Next: Safari > Settings > Extensions, tick Dusk."
