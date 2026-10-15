// eslint-disable-next-line @typescript-eslint/no-require-imports
const { addNip55Query } = require('../plugins/with-nip55-queries.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { secureManifest, BLOCKED, RULES } = require('../plugins/with-kefli-security.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { addReleaseSigning } = require('../plugins/with-release-signing.js');

describe('the NIP-55 manifest query (mobile spec 8.4)', () => {
  test('is added once, beside queries already there', () => {
    const scheme = (m: { queries: { intent: { data?: { $: Record<string, string> }[] }[] }[] }) =>
      m.queries[0].intent.filter((i) => i.data?.some((d) => d.$['android:scheme'] === 'nostrsigner')).length;
    const empty = addNip55Query({});
    expect(scheme(empty)).toBe(1);
    expect(scheme(addNip55Query(empty))).toBe(1);
    const other = addNip55Query({ queries: [{ intent: [{ action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }], data: [{ $: { 'android:scheme': 'https' } }] }] }] });
    expect(other.queries[0].intent).toHaveLength(2);
    const noIntent = addNip55Query({ queries: [{ package: [] }] });
    expect(scheme(noIntent)).toBe(1);
  });
});

describe('backup and permissions (mobile spec 7.1)', () => {
  test('backup off, the rules named, blocked permissions removed and the rest kept', () => {
    const m = secureManifest({
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
      application: [{ $: { 'android:name': '.MainApplication', 'android:allowBackup': 'true' } }],
      'uses-permission': [{ $: { 'android:name': 'android.permission.CAMERA' } }, { $: { 'android:name': 'android.permission.SYSTEM_ALERT_WINDOW' } }],
    });
    expect(m.application[0].$).toMatchObject({ 'android:allowBackup': 'false', 'android:dataExtractionRules': '@xml/kefli_data_extraction', 'android:fullBackupContent': '@xml/kefli_backup' });
    const perms = m['uses-permission'].map((p: { $: Record<string, string> }) => `${p.$['android:name']}${p.$['tools:node'] ? ' x' : ''}`);
    expect(perms).toContain('android.permission.CAMERA');
    expect(perms).not.toContain('android.permission.SYSTEM_ALERT_WINDOW');
    expect(perms.filter((p: string) => p.endsWith(' x'))).toHaveLength(BLOCKED.length);
    expect(secureManifest({ application: [{ $: {} }] })['uses-permission']).toHaveLength(BLOCKED.length);
  });

  test("the background worker's library adds no permission: WorkManager's WAKE_LOCK and RECEIVE_BOOT_COMPLETED are removed (4.8, FD 119)", () => {
    expect(BLOCKED).toContain('android.permission.WAKE_LOCK');
    expect(BLOCKED).toContain('android.permission.RECEIVE_BOOT_COMPLETED');
    const m = secureManifest({
      application: [{ $: {} }],
      'uses-permission': [{ $: { 'android:name': 'android.permission.WAKE_LOCK' } }, { $: { 'android:name': 'android.permission.RECEIVE_BOOT_COMPLETED' } }, { $: { 'android:name': 'android.permission.ACCESS_NETWORK_STATE' } }],
    });
    const kept = m['uses-permission'].filter((p: { $: Record<string, string> }) => !p.$['tools:node']).map((p: { $: Record<string, string> }) => p.$['android:name']);
    expect(kept).toEqual(['android.permission.ACCESS_NETWORK_STATE']);
    expect(() => secureManifest({})).toThrow('no application');
  });

  test('the rules exclude every domain from cloud backup and from device transfer', () => {
    for (const tag of ['cloud-backup', 'device-transfer']) {
      const part = RULES.slice(RULES.indexOf(`<${tag}>`), RULES.indexOf(`</${tag}>`));
      for (const d of ['root', 'file', 'database', 'sharedpref', 'external']) expect(part).toContain(`domain="${d}"`);
    }
  });
});

describe('release signing (with-release-signing.js)', () => {
  // The signing part of Expo SDK 57's generated app/build.gradle.
  const GRADLE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}`;

  test('signs release with the Kefli key when the properties exist, and never with the debug key', () => {
    const out = addReleaseSigning(GRADLE);
    expect(out).toContain('storeFile file(KEFLI_RELEASE_STORE_FILE)');
    expect(out).toContain("signingConfig project.hasProperty('KEFLI_RELEASE_STORE_FILE') ? signingConfigs.release : null");
    const release = out.slice(out.indexOf('buildTypes'));
    expect(release.slice(release.indexOf('release {')).split('}')[0]).not.toContain('signingConfigs.debug');
    expect(out).toMatch(/debug \{\s*signingConfig signingConfigs\.debug/);
  });

  test('patches once', () => {
    const once = addReleaseSigning(GRADLE);
    expect(addReleaseSigning(once)).toBe(once);
  });

  test('stops the build when the template no longer matches', () => {
    expect(() => addReleaseSigning(GRADLE.replace('signingConfig signingConfigs.debug\n            minify', 'minify'))).toThrow('no longer looks as expected');
  });
});
