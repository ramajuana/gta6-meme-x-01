// gta6-meme-x-01 entrypoint.
//
// Node 22, standard library only. The entry itself is the X post: the meme
// (meme.png) and the post text (post-text.txt) are made by the agent and
// posted by the entrant, and this program only hands the post's address to
// the grader. It reads POST.json from the repository root and writes the
// exact same bytes to the output directory, where the gate reads them.
// Nothing this program writes about the post is judged: the house reads the
// post itself from X.
//
// Run it the way the grader does:
//   mkdir -p out && MAKEFUN_BOT_DIR=. MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BOT_DIR = process.env.MAKEFUN_BOT_DIR ?? '/bot';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const sourcePath = join(BOT_DIR, 'POST.json');
const targetPath = join(OUTPUT_DIR, 'POST.json');

// Read the file first so a missing or unreadable POST.json fails loudly
// before anything is written.
const bytes = readFileSync(sourcePath);

// POST.json must be a JSON object naming the post; anything else is a
// broken entry, so refuse to hand it on. The gate also caps the file at
// 16384 bytes, so enforce that here too.
const parsed = JSON.parse(bytes.toString('utf8'));
if (bytes.length > 16384) {
  throw new Error(`POST.json is ${bytes.length} bytes, over the gate's 16384-byte cap`);
}
if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
  throw new Error('POST.json must be a JSON object, e.g. {"url": "https://x.com/<handle>/status/<id>"}');
}
if (typeof parsed.url !== 'string' || parsed.url.length === 0) {
  throw new Error('POST.json must carry a "url" string naming the X post');
}

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(targetPath, bytes);
