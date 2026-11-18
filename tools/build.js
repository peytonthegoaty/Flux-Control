// Full release build: host, installer, dist/FluxControl-Setup.exe, and the update payload (zip + sha256).
//   node tools/build.js
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('VERSION must look like 1.2.3, got ' + version);

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

// keep the app's own package.json in step with VERSION
const pkgPath = path.join(root, 'app', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (pkg.version !== version) { pkg.version = version; fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n'); }

// a syntax error in a shipped script must never reach a release
for (const f of ['app/main.js', 'app/preload.js', 'app/client.js', 'app/viewer.js', 'app/executor.js', 'app/luau.js', 'app/claude.js', 'app/claude-main.js', 'app/mcp.js', 'shared/controls.js', 'shared/hud.js', 'shared/features.js', 'shared/code.js', 'web/web.js', 'installer/ui/app.js']) run('node', ['--check', path.join(root, f)], root);
run('node', [path.join(__dirname, 'check-ui.js')], root);
run('node', [path.join(__dirname, 'test-code.js')], root);
run('node', [path.join(__dirname, 'test-features.js')], root);
run('node', [path.join(__dirname, 'test-loader.js')], root);

// openh264 is about 3.5x slower without NASM (its assembly), which shows up as stutter. Use a portable copy if none is installed.
function ensureNasm() {
  const bin = path.join(__dirname, 'bin');
  const found = () => fs.existsSync(bin) && fs.readdirSync(bin).find((d) => d.startsWith('nasm-') && fs.existsSync(path.join(bin, d, 'nasm.exe')));
  try { execFileSync('nasm', ['-v'], { stdio: 'ignore' }); return; } catch {}
  if (!found()) {
    fs.mkdirSync(bin, { recursive: true });
    const zip = path.join(bin, 'nasm.zip');
    run('curl', ['-sL', '-o', zip, 'https://www.nasm.us/pub/nasm/releasebuilds/2.16.03/win64/nasm-2.16.03-win64.zip'], root);
    run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${bin}' -Force`], root);
    fs.rmSync(zip, { force: true });
  }
  process.env.PATH = path.join(bin, found()) + path.delimiter + process.env.PATH;
}
ensureNasm();

console.log('\n== host');
run('cargo', ['build', '--release'], path.join(root, 'host'));
console.log('\n== installer (embeds the host and the app)');
run('cargo', ['build', '--release'], path.join(root, 'installer'));

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
fs.copyFileSync(path.join(root, 'installer', 'target', 'release', 'flux-setup.exe'), path.join(dist, 'FluxControl-Setup.exe'));

// update payload: exactly what setup writes into %LOCALAPPDATA%\FluxControl (app/, shared/, bin/flux-host.exe)
const stage = path.join(dist, 'stage');
fs.cpSync(path.join(root, 'app'), path.join(stage, 'app'), { recursive: true });
fs.cpSync(path.join(root, 'shared'), path.join(stage, 'shared'), { recursive: true });
fs.mkdirSync(path.join(stage, 'bin'));
fs.copyFileSync(path.join(root, 'host', 'target', 'release', 'flux-host.exe'), path.join(stage, 'bin', 'flux-host.exe'));
fs.writeFileSync(path.join(stage, 'VERSION'), version + '\n');
const zip = path.join(dist, 'flux-control-payload.zip');
run('C:\\Windows\\System32\\tar.exe', ['-a', '-c', '-f', zip, 'app', 'shared', 'bin', 'VERSION'], stage); // bsdtar writes real .zip files
fs.rmSync(stage, { recursive: true, force: true });
const sha = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
fs.writeFileSync(zip + '.sha256', `${sha}  flux-control-payload.zip\n`);
fs.writeFileSync(path.join(dist, 'VERSION'), version + '\n');

const mb = (f) => (fs.statSync(f).size / 1048576).toFixed(1) + ' MB';
console.log(`\nBuilt Flux Control ${version}`);
console.log('  dist/FluxControl-Setup.exe        ', mb(path.join(dist, 'FluxControl-Setup.exe')));
console.log('  dist/flux-control-payload.zip     ', mb(zip));
console.log('  sha256', sha);
