#!/bin/bash
# Builds the release APK for Zapstore and the website: the release variant against the operator's defaults.json, for
# the two ARM ABIs real phones use (x86 is emulators only), signed with Kefli's key from ~/.gradle/gradle.properties
# (plugins/with-release-signing.js). Refuses to finish unless the APK carries that key.
#   apps/mobile/scripts/build-release.sh            → apps/mobile/dist/kefli-<version>.apk
# Afterwards `KEFLI_VARIANT=local npx expo prebuild` puts android/ back for the local stack.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
export KEFLI_DEFAULTS_URL=${KEFLI_DEFAULTS_URL:-https://api.kefli.app/defaults.json}
expected=94:13:53:66:09:47:D6:BC:88:80:24:52:56:A9:C4:37:09:4E:FC:DA:3E:B0:83:EE:04:45:58:E9:D3:EB:C9:79

grep -q '^KEFLI_RELEASE_STORE_FILE=' ~/.gradle/gradle.properties || { echo "no KEFLI_RELEASE_* in ~/.gradle/gradle.properties" >&2; exit 1; }
cd "$here"
CI=1 npx expo prebuild --platform android --clean --no-install
(cd android && ./gradlew --no-daemon assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a)

apk=android/app/build/outputs/apk/release/app-release.apk
tools=$(ls -d "${ANDROID_HOME:-$HOME/Android/Sdk}"/build-tools/* | sort -V | tail -1)
signer=$("$tools/apksigner" verify --print-certs "$apk" | sed -n 's/.*certificate SHA-256 digest: //p' | head -1)
[ "$(echo "$signer" | tr -d ':' | tr a-f A-F)" = "$(echo "$expected" | tr -d ':')" ] || {
  echo "the APK is not signed with Kefli's key (got $signer)" >&2; exit 1; }

version=$(node -p "require('./app.json').expo.version")
mkdir -p dist
cp "$apk" "dist/kefli-$version.apk"
echo "dist/kefli-$version.apk, signed with Kefli's key, sha256 $(sha256sum "dist/kefli-$version.apk" | cut -d' ' -f1)"
