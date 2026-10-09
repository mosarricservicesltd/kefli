// The media notification's small icon (mobile spec 8.7, FD 72 and 94): shared/brand's one-colour glyph, copied into the app's
// drawables at prebuild so the brand build stays its one source. kefli-voice's service sets it on media3's
// notification provider by name.
const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

const SOURCE = path.join(__dirname, '..', '..', '..', 'shared', 'brand', 'out', 'android', 'kefli_notification.xml');

module.exports = function withKefliNotification(config) {
  return withDangerousMod(config, ['android', (c) => {
    const dir = path.join(c.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'drawable');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(SOURCE, path.join(dir, 'kefli_notification.xml'));
    return c;
  }]);
};
