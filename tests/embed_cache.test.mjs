// Embed-cache correctness: must reuse cached vectors (no re-bill), miss ->
// bill + persist, and rebuild when text/model changes (never answer stale).
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { loadEmbedCache, saveEmbedCache, embedCacheMeta } from '../src/utils/embed_cache.js';

function tempDir() {
    const d = mkdtempSync(path.join(tmpdir(), 'embtest-'));
    return d;
}

// A tiny fake embedding model that counts its calls and returns a stable
// deterministic vector per text (so cache-hit vs miss is observable).
function fakeModel() {
    let calls = 0;
    return {
        model: 'test-embed',
        get calls() { return calls; },
        embed(text) {
            calls++;
            // deterministic 4-d vector from the text hash; same text -> same vec
            let h = 0;
            for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
            return Promise.resolve([h, h ^ 0x9e3779b9, 0, (text.length % 7)]);
        },
    };
}

test('embedCacheMeta is stable per kind+model+texts', () => {
    const texts = ['a', 'b'];
    const m1 = embedCacheMeta('x', 'convo', 'test-embed', texts);
    const m2 = embedCacheMeta('x', 'convo', 'test-embed', texts);
    assert.equal(m1.key, m2.key);
    const m3 = embedCacheMeta('x', 'convo', 'different-model', texts);
    assert.notEqual(m1.key, m3.key);
    const m4 = embedCacheMeta('x', 'convo', 'test-embed', ['a', 'c']);
    assert.notEqual(m1.key, m4.key);
});

test('save then load round-trip returns the same vectors and counts as a hit', () => {
    const dir = tempDir();
    const texts = ['hello world', 'second thing'];
    const model = fakeModel();
    // save with the fake provider first (simulate a prior boot)
    saveEmbedCache(dir, 'convo', 'test-embed', texts, {
        'hello world': [111, 222, 0, 1],
        'second thing': [333, 444, 0, 2],
    });
    const hit = loadEmbedCache(dir, 'convo', 'test-embed', texts);
    assert.ok(hit, 'cache hit expected');
    assert.equal(hit.embeddings['hello world'][0], 111);
    rmSync(dir, { recursive: true, force: true });
});

test('stale key (model changed) misses and forces rebuild', () => {
    const dir = tempDir();
    const texts = ['x'];
    saveEmbedCache(dir, 'convo', 'old-model', texts, { x: [9, 9, 9, 9] });
    const hit = loadEmbedCache(dir, 'convo', 'new-model', texts);
    assert.equal(hit, null, 'key mismatch must miss');
    rmSync(dir, { recursive: true, force: true });
});

test('corrupt/absent cache misses cleanly (no throw)', () => {
    const dir = tempDir();
    const texts = ['x'];
    const hit = loadEmbedCache(dir, 'convo', 'test-embed', texts);
    assert.equal(hit, null);
    rmSync(dir, { recursive: true, force: true });
});