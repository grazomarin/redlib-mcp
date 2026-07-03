import * as cheerio from 'cheerio';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./sample-post.html', import.meta.url), 'utf8');
const $ = cheerio.load(html);

// --- diagnostic: what lives directly inside a non-empty .replies? ---
let diagnosed = false;
$('.replies').each((i, el) => {
  if (diagnosed) return;
  const kids = $(el).children().toArray();
  if (kids.some(k => $(k).hasClass('comment'))) {
    console.log('DIAG direct children of a populated .replies:',
      kids.map(k => `${k.tagName}.${($(k).attr('class') || '').trim().split(/\s+/)[0]}`).join(', '));
    diagnosed = true;
  }
});

// --- recursive comment parser ---
function parseComment(el) {
  const $c = $(el);
  const $right = $c.children('.comment_right');
  const $summary = $right.children('.comment_data');
  const $author = $summary.find('a.comment_author').first();
  const authorClass = $author.attr('class') || '';
  const scoreTitle = $c.children('.comment_left').find('.comment_score').attr('title') || '';
  const $replies = $right.children('.replies');

  const replies = [];
  $replies.children('.comment').each((i, child) => replies.push(parseComment(child)));

  return {
    id: $c.attr('id') || '',
    author: $author.text().replace(/^u\//, '').trim(),
    is_op: /\bop\b/.test(authorClass),
    is_mod: /moderator/.test(authorClass),
    score: scoreTitle === 'Hidden' || scoreTitle === '' ? null : parseInt(scoreTitle.replace(/,/g, ''), 10),
    body: $right.children('.comment_body').find('.md').text().trim(),
    more_replies: $replies.children('a.deeper_replies').length > 0,
    replies,
  };
}

const topLevel = $('.thread > .comment').map((i, el) => parseComment(el)).get();

const count = (nodes) => nodes.reduce((s, n) => s + 1 + count(n.replies), 0);
console.log('top-level comments:', topLevel.length);
console.log('total comments parsed:', count(topLevel));
console.log('total .comment in DOM:', $('.comment').length);

// show first thread with a reply, trimmed
const show = (n, d = 0) => {
  console.log('  '.repeat(d) + `[${n.score ?? '?'}] u/${n.author}${n.is_op ? ' (OP)' : ''}${n.is_mod ? ' (MOD)' : ''}${n.more_replies ? ' [+more]' : ''}: ${n.body.slice(0, 70)}`);
  n.replies.forEach(r => show(r, d + 1));
};
console.log('\n--- sample (first 2 threads) ---');
topLevel.slice(0, 2).forEach(t => show(t));
