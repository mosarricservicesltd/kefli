// The media notification's small icon (mobile spec 8.7, FD 72): shared/brand's one-colour glyph, copied into the app's
// drawables at prebuild so the brand build stays its one source. shelf-voice's service sets it on media3's
// notification provider by name.
const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

const SOURCE = path.join(__dirname, '..', '..', '..', 'shared', 'brand', 'out', 'android', 'shelf_notification.xml');

module.exports = function withShelfNotification(config) {
  return withDangerousMod(config, ['android', (c) => {
    const dir = path.join(c.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'drawable');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(SOURCE, path.join(dir, 'shelf_notification.xml'));
    return c;
  }]);
};
