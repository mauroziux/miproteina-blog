#!/usr/bin/env node

/**
 * WordPress → Astro MDX Migration Script
 *
 * Fetches all content from the WP REST API and converts it to
 * Astro content-collection MDX files + JSON data files.
 *
 * Usage:  node scripts/migrate-wp.mjs
 */

import { writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Paths ──────────────────────────────────────────────────────────────
const CONTENT_DIR = join(ROOT, 'src/content/blog');
const DATA_DIR    = join(ROOT, 'src/data');
const SCRIPT_DIR  = join(ROOT, 'scripts');

// ── WP REST API ────────────────────────────────────────────────────────
const WP_BASE = 'https://blog.miproteina.com.co/wp-json/wp/v2';

// ── Helpers ────────────────────────────────────────────────────────────

/** Fetch JSON from a WP endpoint, paginating via `page` until exhausted. */
async function fetchAll(endpoint, perPage = 100) {
  const results = [];
  let page = 1;
  for (;;) {
    const url = `${WP_BASE}${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=${perPage}&page=${page}`;
    console.log(`  GET ${url}`);
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`    ⚠  ${res.status} ${res.statusText} – stopping pagination for ${endpoint}`);
      break;
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    const totalPages = Number(res.headers.get('x-wp-totalpages') || 1);
    if (page >= totalPages) break;
    page++;
  }
  return results;
}

/** Strip all HTML tags, decode common entities. */
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** Escape a string for safe YAML double-quoted value. */
function yamlEscape(str) {
  if (!str) return '""';
  // Wrap in double-quotes; escape inner double-quotes and backslashes
  const escaped = str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, ' ')
    .replace(/\r/g, '');
  return `"${escaped}"`;
}

/** Rewrite WP uploads URL → CDN URL. */
function rewriteImageUrl(url) {
  if (!url) return url;
  // blog.miproteina.com.co/wp-content/uploads/… → cdn.miproteina.com.co/blog/…
  return url.replace(
    /blog\.miproteina\.com\.co\/wp-content\/uploads\//g,
    'cdn.miproteina.com.co/blog/'
  );
}

/** Remove WP image size suffix like -300x200, -1024x682, etc. */
function stripImageSizeSuffix(url) {
  if (!url) return url;
  return url.replace(/(-\d+x\d+)(\.\w+)(?=["?#]|$)/, '$2');
}

/** Remove srcset and sizes attributes from img tags. */
function removeSrcset(html) {
  return html
    .replace(/\s+srcset="[^"]*"/gi, '')
    .replace(/\s+sizes="[^"]*"/gi, '');
}

/** Strip Elementor wrapper divs and excessive inline styles. */
function cleanHtml(html) {
  if (!html) return '';
  let out = html;
  // Remove Elementor wrapper divs (opening)
  out = out.replace(/<div\b[^>]*class="[^"]*elementor[^"]*"[^>]*>/gi, '');
  // Remove data-elementor-type attributes
  out = out.replace(/\s+data-elementor-type="[^"]*"/gi, '');
  out = out.replace(/\s+data-elementor-id="[^"]*"/gi, '');
  // Remove excessive inline styles on divs (keep simple ones)
  out = out.replace(/\s+style="[^"]{100,}"/gi, '');
  return out;
}

/** Rewrite all image URLs in HTML content. */
function rewriteContentImages(html) {
  if (!html) return '';
  let out = html;
  // Match image URLs in src attributes
  out = out.replace(
    /(src=["'])([^"']*?blog\.miproteina\.com\.co\/wp-content\/uploads\/[^"']*)(["'])/gi,
    (match, prefix, url, suffix) => {
      let clean = rewriteImageUrl(url);
      clean = stripImageSizeSuffix(clean);
      return prefix + clean + suffix;
    }
  );
  // Also match in href attributes (links to images)
  out = out.replace(
    /(href=["'])([^"']*?blog\.miproteina\.com\.co\/wp-content\/uploads\/[^"']*)(["'])/gi,
    (match, prefix, url, suffix) => {
      let clean = rewriteImageUrl(url);
      clean = stripImageSizeSuffix(clean);
      return prefix + clean + suffix;
    }
  );
  // Match in srcset (before we strip it)
  out = out.replace(
    /(srcset=["'])([^"']*?blog\.miproteina\.com\.co\/wp-content\/uploads\/[^"']*)(["'])/gi,
    (match, prefix, url, suffix) => {
      let clean = rewriteImageUrl(url);
      clean = stripImageSizeSuffix(clean);
      return prefix + clean + suffix;
    }
  );
  return out;
}

/** Get Yoast description from embedded data. */
function getYoastDescription(post) {
  // Try Yoast head JSON first
  try {
    const yoastHead = post._embedded?.['yoast-head-json'];
    if (yoastHead) {
      const desc = yoastHead.description;
      if (desc) return desc;
    }
  } catch { /* fall through */ }

  // Try yoast_head in rendered form
  try {
    if (post.yoast_head) {
      const match = post.yoast_head.match(/<meta\s+name="description"\s+content="([^"]*)"/);
      if (match) return match[1];
    }
  } catch { /* fall through */ }

  // Fall back to excerpt
  return stripHtml(post.excerpt?.rendered) || '';
}

/** Get author slug from embedded data. */
function getAuthorSlug(post) {
  const author = post._embedded?.author?.[0];
  if (author) {
    return author.slug || author.name || 'mi-proteina';
  }
  return 'mi-proteina';
}

/** Get category name from embedded terms. */
function getCategoryName(post) {
  const terms = post._embedded?.['wp:term']?.[0];
  if (terms && terms.length > 0) {
    // Pick the first category (primary)
    return terms[0].name;
  }
  return 'General';
}

/** Get tag names from embedded terms. */
function getTagNames(post) {
  const termGroups = post._embedded?.['wp:term'];
  if (!termGroups) return [];
  // Tags are in the second group (index 1) typically
  const tags = termGroups[1] || [];
  return tags.map((t) => t.name);
}

/** Build hero image path from featured media. */
function getHeroImagePath(post) {
  const media = post._embedded?.['wp:featuredmedia']?.[0];
  if (!media) return null;
  const sourceUrl = media.source_url;
  if (!sourceUrl) return null;
  let url = rewriteImageUrl(sourceUrl);
  url = stripImageSizeSuffix(url);
  // Extract path after cdn.miproteina.com.co
  const match = url.match(/cdn\.miproteina\.com\.co\/(.+)/);
  if (match) return '/' + match[1];
  // Fallback: use the path part
  try {
    const u = new URL(url);
    return u.pathname;
  } catch {
    return '/' + url;
  }
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 Starting WordPress migration…\n');

  // 1. Fetch all data
  console.log('📥 Fetching posts…');
  const posts = await fetchAll('/posts?_embed');
  console.log(`   ✓ ${posts.length} posts\n`);

  console.log('📥 Fetching categories…');
  const categories = await fetchAll('/categories');
  console.log(`   ✓ ${categories.length} categories\n`);

  console.log('📥 Fetching tags…');
  const tags = await fetchAll('/tags?per_page=200');
  console.log(`   ✓ ${tags.length} tags\n`);

  console.log('📥 Fetching media…');
  const media = await fetchAll('/media?per_page=100');
  console.log(`   ✓ ${media.length} media items\n`);

  console.log('📥 Fetching users…');
  const users = await fetchAll('/users');
  console.log(`   ✓ ${users.length} users\n`);

  // 2. Ensure output directories
  mkdirSync(CONTENT_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(SCRIPT_DIR, { recursive: true });

  // 3. Delete demo posts
  console.log('🗑  Removing demo posts…');
  const demoFiles = readdirSync(CONTENT_DIR).filter(
    (f) => f.endsWith('.md') || f.endsWith('.mdx')
  );
  for (const f of demoFiles) {
    rmSync(join(CONTENT_DIR, f));
    console.log(`   ✓ Deleted ${f}`);
  }
  console.log();

  // 4. Generate MDX files
  console.log('📝 Generating MDX files…');
  const urlMap = [];

  for (const post of posts) {
    const slug = post.slug;
    const title = post.title?.rendered ? stripHtml(post.title.rendered) : slug;
    const description = getYoastDescription(post);
    const pubDate = new Date(post.date_gmt).toISOString().split('T')[0];
    const updatedDate = post.modified_gmt
      ? new Date(post.modified_gmt).toISOString().split('T')[0]
      : pubDate;
    const heroPath = getHeroImagePath(post);
    const category = getCategoryName(post);
    const tagNames = getTagNames(post);
    const author = getAuthorSlug(post);
    const wpId = post.id;

    // Process body
    let body = post.content?.rendered || '';
    body = rewriteContentImages(body);
    body = removeSrcset(body);
    body = cleanHtml(body);

    // Build frontmatter
    const lines = [
      '---',
      `title: ${yamlEscape(title)}`,
      `description: ${yamlEscape(description)}`,
      `pubDate: ${pubDate}`,
      `updatedDate: ${updatedDate}`,
    ];
    if (heroPath) {
      lines.push(`heroImage: ${yamlEscape(heroPath)}`);
    }
    lines.push(`category: ${yamlEscape(category)}`);
    if (tagNames.length > 0) {
      lines.push(`tags:`);
      for (const t of tagNames) {
        lines.push(`  - ${yamlEscape(t)}`);
      }
    } else {
      lines.push(`tags: []`);
    }
    lines.push(`author: ${yamlEscape(author)}`);
    lines.push(`wpSlug: ${yamlEscape(slug)}`);
    lines.push(`wpId: ${wpId}`);
    lines.push('---');
    lines.push('');

    const mdxContent = lines.join('\n') + body;

    const filePath = join(CONTENT_DIR, `${slug}.md`);
    writeFileSync(filePath, mdxContent, 'utf-8');

    urlMap.push({
      wpUrl: post.link,
      newUrl: `https://blog.miproteina.com.co/${slug}/`,
      wpSlug: slug,
    });
  }
  console.log(`   ✓ ${posts.length} MDX files written\n`);

  // 5. Save categories
  const categoriesData = categories.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    count: c.count,
    parent: c.parent,
  }));
  writeFileSync(join(DATA_DIR, 'categories.json'), JSON.stringify(categoriesData, null, 2), 'utf-8');
  console.log(`   ✓ categories.json (${categories.length} entries)`);

  // 6. Save tags
  const tagsData = tags.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    count: t.count,
  }));
  writeFileSync(join(DATA_DIR, 'tags.json'), JSON.stringify(tagsData, null, 2), 'utf-8');
  console.log(`   ✓ tags.json (${tags.length} entries)`);

  // 7. Save authors
  const authorsData = users.map((u) => ({
    id: u.id,
    name: u.name,
    slug: u.slug,
    description: stripHtml(u.description || ''),
    avatarUrl: u.avatar_urls?.['96'] || '',
  }));
  writeFileSync(join(DATA_DIR, 'authors.json'), JSON.stringify(authorsData, null, 2), 'utf-8');
  console.log(`   ✓ authors.json (${users.length} entries)`);

  // 8. Save URL mapping
  writeFileSync(join(SCRIPT_DIR, 'url-map.json'), JSON.stringify(urlMap, null, 2), 'utf-8');
  console.log(`   ✓ url-map.json (${urlMap.length} entries)`);

  console.log('\n✅ Migration complete!');
}

main().catch((err) => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
