/**
 * afterPack hook: Ad-hoc sign the app bundle on macOS.
 * Uses "-" identity (no Apple Developer account required).
 * Do NOT use --options runtime — hardened runtime blocks node-pty's PTY syscalls.
 */
const { execSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack({ appOutDir, packager }) {
  if (packager.platform.name !== 'mac') return;

  const appName = `${packager.appInfo.productName}.app`;
  const appPath = path.join(appOutDir, appName);
  console.log(`\n[afterPack] Ad-hoc signing: ${appPath}`);

  try {
    // Remove quarantine / extended attributes
    execSync(`xattr -cr "${appPath}"`, { stdio: 'pipe' });

    // Sign all nested .node native modules first (node-pty etc.)
    try {
      execSync(
        `find "${appPath}" -name "*.node" | while read f; do codesign --force --sign - "$f"; done`,
        { stdio: 'pipe', shell: true }
      );
    } catch (_) {}

    // Ad-hoc sign the whole bundle (deep, no hardened runtime)
    execSync(
      `codesign --force --deep --sign - "${appPath}"`,
      { stdio: 'inherit' }
    );
    console.log('[afterPack] Ad-hoc signing complete.\n');
  } catch (err) {
    console.warn('[afterPack] Signing warning (non-fatal):', err.message);
  }
};
