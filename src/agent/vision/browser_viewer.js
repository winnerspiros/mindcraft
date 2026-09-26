import settings from '../settings.js';

// prismarine-viewer + three + node-canvas-webgl + gl/canvas native addons are a
// ~400MB 3D/WebGL stack that is only needed when render_bot_view is on. This box
// runs headless (render_bot_view=false), so import it lazily to keep it out of RAM.
export async function addBrowserViewer(bot, count_id, force = false) {
    if (!settings.render_bot_view && !force)
        return false;
    try {
        const mod = await import('prismarine-viewer');
        const prismarineViewer = mod.default ?? mod;
        const mineflayerViewer = prismarineViewer.mineflayer;
        mineflayerViewer(bot, { port: 3000 + count_id, firstPerson: true });
        bot._viewerOn = true;
        return true;
    } catch (e) {
        console.warn('[viewer] start failed:', e.message);
        return false;
    }
}

// Tear the viewer down: mineflayerViewer() opens an express + socket.io
// server per bot with no documented close handle on 1.33.0 — the handles
// live on bot.viewer / bot._viewer. Best-effort close of both, then flag.
export async function removeBrowserViewer(bot) {
    let closed = false;
    for (const key of ['_viewer', 'viewer']) {
        try {
            const v = bot[key];
            if (!v) continue;
            if (typeof v.close === 'function') { await v.close(); closed = true; }
            else if (typeof v.stop === 'function') { await v.stop(); closed = true; }
            else if (v.server && typeof v.server.close === 'function') { await new Promise(r => v.server.close(r)); closed = true; }
            else if (v.app && typeof v.app.close === 'function') { await v.app.close(); closed = true; }
        } catch (_) {}
    }
    try { bot._viewerOn = false; } catch (_) {}
    return closed;
}

export function isViewerOn(bot) {
    return !!(bot && bot._viewerOn);
}
