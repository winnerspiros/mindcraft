// Persistent disk cache for STATIC text embeddings.
//
// WHY: on every boot the bot re-embeds the same 194 conversation examples and
// ~290 skill doc headers through a PAID embedding model (text-embedding-3-small
// via OpenRouter). Their text never changes between restarts, so those ~500
// API calls are burned fresh each boot for identical vectors. Keyed on a hash
// of the input texts + model, this makes them computed once and reused.
// Behavior is identical (same vectors, same cosine ranking), only the number
// of paid calls drops.
//
// OpenRouter now lists ZERO embedding models, so a "free embedding" swap is a
// dead end on this box; persistence is the honest, behavior-preserving win.
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { mkdirSync } from 'fs';
import path from 'path';

// Cache files live under bots/<name>/embed_cache/ (per-agent, gitignored zone).
// `cacheDir` is a fully-resolved directory path (e.g. 'bots/UwU/embed_cache' or
// an absolute tmpdir in tests). It is used verbatim — no 'bots/' re-prefixing —
// so callers own the full path and there is exactly one join.
export function embedCacheFile(cacheDir, kind) {
    return path.join(cacheDir, `${kind}.json`);
}

// Stable hash of ordered texts + model identity. Any text or model change
// produces a new key, so a stale cache can never answer for changed content.
function keyOf(kind, model, texts) {
    const h = createHash('sha256');
    h.update(kind);
    if (model && typeof model === 'string') h.update('\u0000' + model);
    h.update('\u0000' + texts.length);
    for (const t of texts) h.update('\u0000' + String(t));
    return h.digest('hex').slice(0, 32);
}

export function embedCacheMeta(cacheDir, kind, model, texts) {
    return { key: keyOf(kind, model, texts), model: model || null, n: texts.length };
}

// Load cache. Returns { key, embeddings: {text: vec} } or null if absent.
export function loadEmbedCache(cacheDir, kind, model, texts) {
    const { key } = embedCacheMeta(cacheDir, kind, model, texts);
    const fp = embedCacheFile(cacheDir, kind);
    try {
        if (!existsSync(fp)) return null;
        const data = JSON.parse(readFileSync(fp, 'utf8'));
        if (!data || data.key !== key || !data.embeddings) return null; // stale/mismatch
        // Cache the whole known set under the key even if only a subset matches:
        // return the full map so a caller can consult all texts, but the caller
        // decides which entries it needs.
        return { key, embeddings: data.embeddings, model: data.model };
    } catch (e) {
        return null; // corrupt -> treat as absent, rebuild
    }
}

// Persist embeddings under the key. Atomically-ish (write temp, rename is overkill
// for a single-agent box; direct write is fine here).
export function saveEmbedCache(cacheDir, kind, model, texts, embeddings) {
    const { key } = embedCacheMeta(cacheDir, kind, model, texts);
    try {
        mkdirSync(cacheDir, { recursive: true });
        const fp = embedCacheFile(cacheDir, kind);
        writeFileSync(fp, JSON.stringify({ key, model, embeddings }), 'utf8');
    } catch (e) {
        // non-fatal: cache is an optimization, never a correctness gate
        console.warn(`embed cache save failed (${kind}):`, e.message);
    }
}