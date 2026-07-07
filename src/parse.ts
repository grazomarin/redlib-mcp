import * as cheerio from "cheerio";
import { assertContentLoaded } from "./errors.js";

// Pure Redlib-HTML -> compact-JSON parsers, extracted from index.ts so they are unit-testable
// (importing index.ts starts the MCP server as a side effect). No I/O, no globals — the post-media
// base URL is passed in. Each parser loads cheerio ONCE and asserts content on that same $ (callers
// no longer pre-call assertRedlibContent — that would be a second full parse of the same html).

export const COMMENT_BODY_CAP = 1200;

export function exactScore($el: cheerio.Cheerio<any>): number | null {
  const title = ($el.attr("title") || "").trim();
  if (title && title !== "Hidden") { const t = parseInt(title.replace(/,/g, ""), 10); return Number.isNaN(t) ? null : t; }
  const text = $el.text().trim().replace(/,/g, "");
  const n = parseInt(text, 10);
  return Number.isNaN(n) ? null : n;
}

export function cleanTitle($titleEl: cheerio.Cheerio<any>): string {
  const $clone = $titleEl.clone();
  $clone.find(".post_flair").remove();
  return $clone.text().replace(/\s+/g, " ").trim();
}

// Post-list HTML (search / subreddit / user listings) -> compact JSON.
// permalink is the canonical reddit.com URL so the agent can cite it.
export function parsePostList(html: string) {
  const $ = cheerio.load(html);
  assertContentLoaded($);
  const results: Array<Record<string, unknown>> = [];
  $(".post").each((_i, el) => {
    const $el = $(el);
    const $titleEl = $el.find(".post_title").first();
    const $titleLink = $titleEl.find("a").filter((_j, a) => !$(a).hasClass("post_flair")).first();
    const title = cleanTitle($titleEl);
    const href = $titleLink.attr("href") || "";
    let id = $el.attr("id") || "";
    if (!id) { const m = href.match(/\/comments\/([a-z0-9]+)/i); id = m ? m[1] : ""; }
    if (!id || !title) return;
    const commentsText = $el.find(".post_comments").first().text().trim();
    const cm = commentsText.match(/([\d,]+)/);
    const author = $el.find(".post_author").text().replace(/^u\//, "").trim();
    const flair = $titleEl.find(".post_flair").text().trim();
    const post: Record<string, unknown> = {
      id, title,
      subreddit: $el.find(".post_subreddit").text().replace("r/", "").trim(),
      score: exactScore($el.find(".post_score").first()),
      comment_count: cm ? parseInt(cm[1].replace(/,/g, ""), 10) : 0,
      url: href ? `https://www.reddit.com${href}` : null,
    };
    if (author) post.author = author;
    if (flair) post.flair = flair;
    results.push(post);
  });
  return results;
}

// Next-page cursor from a Redlib listing footer (?...after=t3_<id>).
export function nextAfter(html: string): string | null {
  const m = html.match(/after=(t3_[a-z0-9]+)/i);
  return m ? m[1] : null;
}

export interface CommentNode {
  author: string | null;
  score: number | null;
  body: string;
  is_op?: boolean;
  is_mod?: boolean;
  is_deleted?: boolean;
  is_removed?: boolean;
  more_id?: string;   // Redlib-collapsed replies; expand via get_post(comment_id)
  truncated?: boolean; // replies cut by max_comments budget
  replies: CommentNode[];
}

export function buildComment($: cheerio.CheerioAPI, el: any): CommentNode {
  const $c = $(el);
  const $right = $c.children(".comment_right");
  const $summary = $right.children(".comment_data");
  const $author = $summary.find("a.comment_author").first();
  const authorClass = $author.attr("class") || "";
  const authorText = $author.text().replace(/^u\//, "").trim();
  const rawBody = $right.children(".comment_body").find(".md").text().trim();
  const body = rawBody.length > COMMENT_BODY_CAP ? rawBody.slice(0, COMMENT_BODY_CAP) + " …[truncated]" : rawBody;
  const $replies = $right.children(".replies");

  const node: CommentNode = {
    author: authorText || null,
    score: exactScore($c.children(".comment_left").find(".comment_score")),
    body,
    replies: [],
  };
  if (/\bop\b/.test(authorClass)) node.is_op = true;
  if (/moderator/.test(authorClass)) node.is_mod = true;
  if (!authorText || authorText === "[deleted]") node.is_deleted = true;
  if (rawBody === "[removed]" || rawBody === "[deleted]") node.is_removed = true;
  const deeper = $replies.children("a.deeper_replies").first().attr("href");
  if (deeper) { const seg = deeper.split("/").filter(Boolean).pop(); if (seg) node.more_id = seg; }

  $replies.children(".comment").each((_i, child) => { node.replies.push(buildComment($, child)); });
  return node;
}

// Compact serialization: omit false flags and empty replies to save agent tokens.
export function serializeComment(n: CommentNode): Record<string, unknown> {
  const o: Record<string, unknown> = { author: n.author, score: n.score, body: n.body };
  if (n.is_op) o.is_op = true;
  if (n.is_mod) o.is_mod = true;
  if (n.is_deleted) o.is_deleted = true;
  if (n.is_removed) o.is_removed = true;
  if (n.more_id) o.more_id = n.more_id;
  if (n.truncated) o.truncated = true;
  if (n.replies.length) o.replies = n.replies.map(serializeComment);
  return o;
}

// Keep the first `budget` nodes in BREADTH-first order (all top-levels + shallow
// replies before deep tails), so a single mega-thread can't starve the rest.
export function pruneBFS(roots: CommentNode[], budget: number): { kept: CommentNode[]; count: number } {
  const keep = new Set<CommentNode>();
  let level = roots.slice();
  let count = 0;
  while (level.length && count < budget) {
    const next: CommentNode[] = [];
    for (const n of level) {
      if (count >= budget) break;
      keep.add(n); count++;
      for (const c of n.replies) next.push(c);
    }
    level = next;
  }
  const rebuild = (n: CommentNode): CommentNode => {
    const kept = n.replies.filter((c) => keep.has(c));
    if (kept.length < n.replies.length) n.truncated = true;
    n.replies = kept.map(rebuild);
    return n;
  };
  const keptRoots = roots.filter((n) => keep.has(n)).map(rebuild);
  return { kept: keptRoots, count };
}

export function parsePostDetails(html: string, maxComments: number, baseUrl: string) {
  const $ = cheerio.load(html);
  assertContentLoaded($);
  const roots = $(".thread > .comment").map((_i, el) => buildComment($, el)).get() as CommentNode[];
  const { kept, count } = pruneBFS(roots, maxComments);

  const $titleEl = $(".post_title").first();
  const postType = (html.match(/<!--\s*post_type:\s*([\w:.-]+)\s*-->/) || [])[1] || null;
  const outbound = $("#post_url").attr("href") || "";
  const mediaHref = $(".post_media_content a").first().attr("href") || $(".post_media_content img").first().attr("src") || "";
  const media = mediaHref ? (mediaHref.startsWith("http") ? mediaHref : `${baseUrl}${mediaHref}`) : "";
  const flair = $titleEl.find(".post_flair").text().trim();
  const body = $(".post_body .md, .post-content .md").first().text().trim().substring(0, 4000);
  const commentsInPageText = $(".post_comments").first().text().trim().match(/([\d,]+)/);

  const out: Record<string, unknown> = {
    title: cleanTitle($titleEl),
    subreddit: $(".post_subreddit").first().text().replace("r/", "").trim(),
    author: $(".post_author").first().text().replace(/^u\//, "").trim() || null,
    score: exactScore($(".post_score").first()),
    post_type: postType,
    reddit_url: $("#reddit_url").first().text().trim() || null,
    comments_total: commentsInPageText ? parseInt(commentsInPageText[1].replace(/,/g, ""), 10) : null,
    comments_in_page: $(".comment").length,
    comments_returned: count,
    comments: kept.map(serializeComment),
  };
  if (outbound || media) out.url = outbound || media;
  if (flair) out.flair = flair;
  if (body) out.body = body;
  return out;
}
