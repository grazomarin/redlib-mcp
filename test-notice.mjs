import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const lic = readFileSync('LICENSE', 'utf8');
assert.ok(/MIT License/i.test(lic), 'LICENSE stays MIT');
assert.ok(/Redlib MCP Server Contributors/.test(lic), 'preserve the inherited upstream copyright line');
assert.ok(/Modifications .*grazomarin|Kamran/i.test(lic), 'add the fork modification notice');

const notice = readFileSync('NOTICE', 'utf8');
assert.ok(/Redlib/.test(notice) && /AGPL-3\.0/.test(notice), 'NOTICE records Redlib AGPL-3.0');
assert.ok(/build(s|t)? .* on your (own )?machine|not (bundled|vendored|distributed)/i.test(notice), 'NOTICE states Redlib is built locally, not distributed by us');
assert.ok(/Devthatdoes|devthatdoes/.test(notice), 'NOTICE records the devthatdoes origin');
assert.ok(/not affiliated with (or endorsed by )?Reddit, Inc\./i.test(notice), 'NOTICE carries the Reddit trademark disclaimer');
console.log('ALL PASS');
