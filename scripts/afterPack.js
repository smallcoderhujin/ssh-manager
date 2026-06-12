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

    // Fix execute permissions for node-pty's spawn-helper binaries.
    // electron-builder copies them with 644 (no execute bit), causing posix_spawnp to fail.
    try {
      execSync(
        `find "${appPath}" -name "spawn-helper" -exec chmod +x {} \\;`,
        { stdio: 'pipe', shell: true }
      );
      console.log('[afterPack] Fixed spawn-helper permissions.');
    } catch (_) {}

    // Sign all nested .node native modules and spawn-helper binaries
    try {
      execSync(
        `find "${appPath}" \\( -name "*.node" -o -name "spawn-helper" \\) | while read f; do codesign --force --sign - "$f"; done`,
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
