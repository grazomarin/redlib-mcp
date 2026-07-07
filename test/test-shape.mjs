import assert from 'node:assert';
import { assertRedlibContent } from '../dist/errors.js';

// A valid Redlib content page (even an EMPTY listing) has the #column_one shell -> no throw.
assert.doesNotThrow(() => assertRedlibContent('<html><body><div id="column_one"><div id="posts"></div></div></body></html>'));
// A 200 error/info page renders <div id="error"> -> PARSE_ERROR.
assert.throws(() => assertRedlibContent('<html><body><div id="error"><h2>Subreddit is private</h2></div></body></html>'), (e) => e.kind === 'PARSE_ERROR');
// Drift: neither shell nor error marker -> PARSE_ERROR.
assert.throws(() => assertRedlibContent('<html><body>totally different</body></html>'), (e) => e.kind === 'PARSE_ERROR');
// A valid content page whose comment TEXT contains the literal string id="error" must NOT be rejected
// (structural check looks at the #error ELEMENT, not a substring).
assert.doesNotThrow(() => assertRedlibContent('<html><body><div id="column_one"><div class="comment"><div class="md">see id="error" in your CSS</div></div></div></body></html>'));
console.log('ALL PASS');
