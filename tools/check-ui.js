// Fails if any UI file uses a default (native) control. See CLAUDE.md.
const fs = require('fs');
const path = require('path');

const rules = [
  [/<select\b|<option\b|<datalist\b/i, 'native dropdown: use .fx-select'],
  [/<input[^>]*type\s*=\s*["']?(range|checkbox|radio|file|number|date|time|color)/i, 'native input type: use fx-slider/fx-toggle/fx-card'],
  [/<textarea\b/i, 'native textarea'],
  [/<input(?![^>]*class\s*=\s*["'][^"']*fx-input)/i, 'input without class fx-input'],
  [/\b(alert|confirm|prompt)\s*\(/, 'native dialog: use fx.toast()'],
  [/<dialog\b/i, 'native dialog element'],
  [/\stitle\s*=\s*["']/i, 'native tooltip (title=)'],
];

const roots = ['installer/ui', 'shared', 'app', 'web'];
const exts = new Set(['.html', '.js', '.css']);
let bad = 0;

function walk(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.name === 'node_modules') continue;
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p);
    else if (exts.has(path.extname(f.name))) scan(p);
  }
}

function scan(file) {
  const text = fs.readFileSync(file, 'utf8');
  const isCss = file.endsWith('.css');
  text.split('\n').forEach((line, i) => {
    if (isCss) return;
    for (const [re, msg] of rules) {
      if (re.test(line) && !line.includes('check-ui:ignore')) {
        console.log(`${file}:${i + 1}  ${msg}`);
        bad++;
      }
    }
  });
  if (isCss && !/scrollbar-width:\s*none/.test(text) && file.endsWith('shared' + path.sep + 'style.css')) {
    console.log(`${file}  missing global scrollbar-width:none`);
    bad++;
  }
}

const base = path.join(__dirname, '..');
for (const r of roots) if (fs.existsSync(path.join(base, r))) walk(path.join(base, r));
console.log(bad ? `\n${bad} violation(s)` : 'ui check passed');
process.exit(bad ? 1 : 0);
