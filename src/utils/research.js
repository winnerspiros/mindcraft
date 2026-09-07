// Keyless web research for build references. The bot has no hardcoded design
// library — when she wants a reference she looks one up, then designs her OWN
// thing freely. Primary source: Minecraft Wiki (MediaWiki full-text search);
// fallback: DuckDuckGo Instant Answer. Returns compact, citable text she can read
// into her design context. Intentionally small + bounded (a few calls, ~8s each).

// timeout-guarded fetch so a slow/hung network can't stall the bot
async function fetchTimeout(url, ms = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        return await fetch(url, { signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
    }
}

// Minecraft Wiki full-text search -> [{title, snippet}] (snippet is plain text).
async function minecraftWikiSearch(query) {
    const r = await fetchTimeout(
        `https://minecraft.wiki/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=5&format=json&origin=*`
    );
    if (!r.ok) return [];
    const j = await r.json();
    return (j?.query?.search || []).map(s => ({ title: s.title, snippet: (s.snippet || '').replace(/<[^>]+>/g, '') }));
}

// Find direct .schem/.schematic file URLs inside a GitHub repo (unauthenticated
// tree walk). Returns up to `limit` { name, url } raw-download links, or [].
async function findSchematicsInRepo(owner, repo, branch, limit = 5) {
    try {
        const r = await fetchTimeout(
            `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`
        );
        if (!r.ok) return [];
        const j = await r.json();
        if (j.truncated) return [];
        return (j.tree || [])
            .filter(e => e.type === 'blob' && /\.(schem|schematic)$/i.test(e.path))
            .slice(0, limit)
            .map(e => ({
                name: e.path.split('/').pop(),
                url: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${e.path.split('/').map(encodeURIComponent).join('/')}`,
            }));
    } catch (e) { return []; }
}

// Search schematic-hosting sources for a topic and return actual .schem/.schematic
// download links (GitHub, keyless). This is discovery: it finds FILE links she can
// feed to !fetchSchematic. Most dedicated sites (planetminecraft, minecraft-schematics)
// have no clean keyless API, so GitHub is the reliable source here.
export async function searchSchematics(term) {
    const q = String(term || '').trim();
    if (!q) return '';
    const out = [];
    try {
        const r = await fetchTimeout(
            `https://api.github.com/search/repositories?q=${encodeURIComponent('minecraft schematic ' + q)}&per_page=5`
        );
        if (!r.ok) return '';
        const j = await r.json();
        for (const repo of (j.items || []).slice(0, 3)) {
            const files = await findSchematicsInRepo(repo.owner.login, repo.name, repo.default_branch);
            if (!files.length) continue;
            out.push(`${repo.full_name} — ${files.length} schematic file${files.length > 1 ? 's' : ''}:`);
            for (const f of files.slice(0, 3)) out.push(`    ${f.name}  ${f.url}`);
        }
    } catch (e) { /* discovery is best-effort */ }
    return out.join('\n');
}
export async function researchBuildTopic(query) {
    const q = String(query || '').trim();
    if (!q) return '';

    const out = [];
    for (const variant of [q, `${q} build`, `${q} structure`]) {
        let hits = [];
        try { hits = await minecraftWikiSearch(variant); } catch (e) { /* try next */ }
        if (hits.length) {
            out.push(`minecraft.wiki: ${hits.map(h => h.title).slice(0, 5).join(' | ')}`);
            const best = hits.find(h => /tutorial|build|house|structure|wall|tower/i.test(h.title)) || hits[0];
            if (best.snippet) out.push(`  (${best.title}) ${best.snippet.replace(/\s+/g, ' ').trim().slice(0, 450)}`);
            break;
        }
    }

    if (out.length === 0) {
        try {
            const r = await fetchTimeout(`https://api.duckduckgo.com/?q=${encodeURIComponent(q + ' minecraft build')}&format=json&no_html=1&skip_disambig=1&t=uwu-bot`);
            const d = await r.json();
            const a = (d.AbstractText || d.Answer || d.Definition || '').trim();
            if (a) out.push(`[web] ${a.replace(/\s+/g, ' ').trim().slice(0, 500)}`);
        } catch (e) { /* give up */ }
    }

    return out.join('\n');
}