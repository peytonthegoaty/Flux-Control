// Prints the REGISTRY line for a dev code (see shared/features.js).
//   node tools/make-dev-code.js "MY-CODE" my-feature-id "Feature name" "What it does"
const F = require('../shared/features.js');
const [code, id, name, desc] = process.argv.slice(2);
if (!code || !id || !name) { console.error('usage: node tools/make-dev-code.js "CODE" feature-id "Name" "Description"'); process.exit(1); }
F.sha(F.norm(code)).then((h) => console.log(`    '${h}': { id: '${id}', name: ${JSON.stringify(name)}, desc: ${JSON.stringify(desc || '')} },`));
