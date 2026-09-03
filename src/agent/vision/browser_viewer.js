import settings from '../settings.js';

// prismarine-viewer + three + node-canvas-webgl + gl/canvas native addons are a
// ~400MB 3D/WebGL stack that is only needed when render_bot_view is on. This box
// runs headless (render_bot_view=false), so import it lazily to keep it out of RAM.
export async function addBrowserViewer(bot, count_id) {
    if (!settings.render_bot_view)
        return;
    const mod = await import('prismarine-viewer');
    const prismarineViewer = mod.default ?? mod;
    const mineflayerViewer = prismarineViewer.mineflayer;
    mineflayerViewer(bot, { port: 3000 + count_id, firstPerson: true });
}
