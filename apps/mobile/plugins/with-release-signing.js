// Signs release builds with Kefli's own key, which every channel (Zapstore, the APK on the website, Play) shares so
// that each can update the others. The key and its passwords stay outside the repository, in ~/.gradle/gradle.properties
// as KEFLI_RELEASE_STORE_FILE, KEFLI_RELEASE_STORE_PASSWORD, KEFLI_RELEASE_KEY_ALIAS and KEFLI_RELEASE_KEY_PASSWORD.
// Without them a release build comes out unsigned, never signed with the debug key.
const { withAppBuildGradle } = require('expo/config-plugins');

const SIGNING = `
        release {
            if (project.hasProperty('KEFLI_RELEASE_STORE_FILE')) {
                storeFile file(KEFLI_RELEASE_STORE_FILE)
                storePassword KEFLI_RELEASE_STORE_PASSWORD
                keyAlias KEFLI_RELEASE_KEY_ALIAS
                keyPassword KEFLI_RELEASE_KEY_PASSWORD
            }
        }`;

// Adds the release signing config to app/build.gradle's text, once; throws if Expo's template has moved on.
function addReleaseSigning(gradle) {
  if (gradle.includes('KEFLI_RELEASE_STORE_FILE')) return gradle;
  const out = gradle
    .replace(/signingConfigs \{/, (m) => m + SIGNING)
    .replace(
      /(release \{[^{}]*?)signingConfig signingConfigs\.debug/,
      "$1signingConfig project.hasProperty('KEFLI_RELEASE_STORE_FILE') ? signingConfigs.release : null",
    );
  if (!out.includes('? signingConfigs.release : null')) {
    throw new Error('with-release-signing: the release build type in app/build.gradle no longer looks as expected');
  }
  return out;
}

function withReleaseSigning(config) {
  return withAppBuildGradle(config, (c) => {
    c.modResults.contents = addReleaseSigning(c.modResults.contents);
    return c;
  });
}

module.exports = withReleaseSigning;
module.exports.addReleaseSigning = addReleaseSigning;
