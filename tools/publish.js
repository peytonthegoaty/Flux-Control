// Publishes the current build as a GitHub release. Installed copies pick it up the next time setup is launched.
//   node tools/build.js && node tools/publish.js "what changed"
// Needs the GitHub CLI logged in (gh auth login). Run only when you mean to ship an update.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = 'peytonthegoaty/Flux-Control';
const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
const built = fs.existsSync(path.join(dist, 'VERSION')) ? fs.readFileSync(path.join(dist, 'VERSION'), 'utf8').trim() : null;
if (built !== version) { console.error(`dist/ is for ${built || 'nothing'}, VERSION is ${version}. Run node tools/build.js first.`); process.exit(1); }

const tag = 'v' + version;
const gh = (args, opts = {}) => execFileSync('gh', args, { encoding: 'utf8', ...opts });

try { gh(['release', 'view', tag, '--repo', REPO], { stdio: 'pipe' }); console.error(`${tag} is already published. Bump VERSION first.`); process.exit(1); } catch {}

const notes = process.argv[2] || `Flux Control ${version}`;
const files = ['flux-control-payload.zip', 'flux-control-payload.zip.sha256', 'FluxControl-Setup.exe'].map((f) => path.join(dist, f));
console.log(gh(['release', 'create', tag, ...files, '--repo', REPO, '--title', `Flux Control ${version}`, '--notes', notes, '--latest']).trim());
