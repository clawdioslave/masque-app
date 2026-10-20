#!/bin/zsh
# Build, sign (Developer ID), notarize with Apple, and publish the Masque app as a GitHub release.
#   npm run release
set -e
cd "$(dirname "$0")/.."
security find-identity -v -p codesigning | grep -q "Developer ID Application" || { echo "No Developer ID Application certificate on this Mac (Xcode > Settings > Accounts > Manage Certificates > + Developer ID Application)"; exit 2; }
export APPLE_API_KEY="$HOME/.appstoreconnect/private_keys/AuthKey_ABF7B9XBD8.p8" APPLE_API_KEY_ID=ABF7B9XBD8 APPLE_API_ISSUER=2f4051ab-770b-4b0e-a1a5-ebdca210fec9
rm -rf dist
npx electron-builder --mac --universal
V=$(node -p "require('./package.json').version")
spctl -a -vvv -t install dist/Masque.dmg 2>&1 | tail -3
xcrun stapler validate dist/Masque.dmg
gh release create "v$V" dist/Masque.dmg dist/Masque-mac.zip --repo clawdioslave/masque-app --title "Masque $V" --notes "Masque for Mac $V. Download from https://clawdioslave.com/masque/app/"
echo "released v$V"
