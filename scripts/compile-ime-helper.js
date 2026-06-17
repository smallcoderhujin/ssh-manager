// Compile the Windows IME helper using the built-in .NET Framework csc.exe.
// csc.exe ships with every Windows 10/11 machine; no VS or SDK required.
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

if (process.platform !== 'win32') process.exit(0);

const cscPaths = [
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'),
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET\\Framework64\\v3.5\\csc.exe'),
];

const csc = cscPaths.find(p => fs.existsSync(p));
if (!csc) {
  console.log('csc.exe not found — skipping IME helper compilation');
  process.exit(0);
}

const src = path.join(__dirname, 'ime-helper.cs');
const out = path.join(__dirname, '..', 'assets', 'ime-helper.exe');

try {
  execSync(`"${csc}" /nologo /optimize /target:winexe /platform:x64 /out:"${out}" "${src}"`, {
    stdio: 'inherit',
  });
  console.log('✓ ime-helper.exe compiled to', out);
} catch (e) {
  console.error('ime-helper.exe compilation failed:', e.message);
  process.exit(1);
}
