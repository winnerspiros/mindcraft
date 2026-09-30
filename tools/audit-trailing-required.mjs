// A param with no `default` is REQUIRED (index.js:213). So a command whose LAST
// param lacks a default cannot be called with only its leading args, even when
// every earlier param has a default and the intent is clearly "optional".
// Find every such command.
// Enter via index.js first, as agent.js does, to avoid the actions<->queries
// <->index import cycle TDZ trap.
const idx = await import('../src/agent/commands/index.js');
const { actionsList } = await import('../src/agent/commands/actions.js');
const suspects = [];
for (const c of actionsList) {
    const params = c.params ? Object.values(c.params) : [];
    if (params.length < 2) continue;
    const last = params[params.length - 1];
    if ('default' in last) continue;
    // does it have at least one earlier optional param? then the shape is odd
    const earlierOptional = params.slice(0, -1).filter(p => 'default' in p).length;
    if (earlierOptional === 0) continue;   // all-required command, fine
    suspects.push({ name: c.name, lastParam: 'n/a', total: params.length });
}

// name the actual last param key from source
import { promises as fsp } from 'node:fs';
const src = await fsp.readFile('./src/agent/commands/actions.js', 'utf8');
for (const s of suspects) {
    const bare = s.name.replace(/^!/, '');
    const re = new RegExp(`name: '${s.name.replace(/[!]/g, '\\!')}'([\\s\\S]*?)perform:`);
    const m = src.match(re);
    if (!m) continue;
    const keys = [...m[1].matchAll(/'([a-zA-Z_][\w]*)':\s*\{/g)].map(x => x[1]);
    s.lastParam = keys[keys.length - 1] || '?';
    // try invoking with just the first param
    const test = `!${bare}("x")`;
    const parsed = idx.parseCommandMessage(test);
    s.works = typeof parsed !== 'string';
}

console.log('commands whose LAST param has no default but earlier ones do:', suspects.length);
for (const s of suspects) console.log(`  ${s.name}  lastParam=${s.lastParam}  !${s.name.replace(/^!/, '')}("x") works=${s.works}`);
