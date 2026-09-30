// End-to-end dispatch audit: for every registered command, feed the parser a
// syntactically valid invocation and confirm it resolves to a real command with
// the right argument count. This is the layer that catches "I typed it and it
// said 'was given N args'" for commands nobody has ever tried.
const idx = await import('../src/agent/commands/index.js');
const { actionsList } = await import('../src/agent/commands/actions.js');

let parseFail = 0, argFail = 0, noDefault = 0;
const report = [];

for (const c of actionsList) {
    const bare = c.name.replace(/^!/, '');
    const params = c.params ? Object.values(c.params) : [];

    // Build a valid invocation using each param's declared type/default.
    const argsFor = (onlyRequired) => params
        .filter(p => onlyRequired ? !('default' in p) : true)
        .map(p => {
            if ('default' in p) return String(p.default);
            switch (p.type) {
                case 'int': case 'float': {
                    // a domain can be an empty/undefined pair; also never emit
                    // -Infinity, which is not a parseable arg token at all
                    const d = Array.isArray(p.domain) ? p.domain : null;
                    let v = 1;
                    if (d && d.length === 2 && Number.isFinite(d[0])) {
                        v = Math.max(Math.ceil(d[0]), -1000);
                        if (!Number.isFinite(v)) v = 1;
                    }
                    return String(v);
                }
                case 'boolean': return 'false';
                default: return `"x"`;
            }
        });

    for (const onlyRequired of [true, false]) {
        const list = argsFor(onlyRequired);
        // skip invalid BlockName/ItemName by name; those need real ids
        const needsRealName = params.some(p => !('default' in p) && /Name$/.test(p.type || ''));
        if (needsRealName) continue;

        const msg = onlyRequired
            ? `!${bare}${list.length ? '(' + list.join(', ') + ')' : ''}`
            : `!${bare}(${list.join(', ')})`;

        const info = idx.getCommandInfo(msg);
        if (!info) { parseFail++; report.push(`PARSE-FAIL ${c.name} :: ${msg}`); continue; }
        if (info.name !== c.name) { parseFail++; report.push(`NAME-MISMATCH ${c.name} -> ${info.name} :: ${msg}`); continue; }
        const parsed = idx.parseCommandMessage(msg);
        if (typeof parsed === 'string') { parseFail++; report.push(`REJECT ${c.name} :: ${msg} -> ${parsed}`); continue; }
        // The parser PADS trailing default params up to the full param count
        // (index.js:288), so a command invoked with only its required args still
        // parses to params.length. The correct invariant is:
        //   required-only call -> must NOT be rejected, and must pad to full
        //   full call          -> must parse to exactly params.length
        const full = params.length;
        const got = parsed.args ? parsed.args.length : 0;
        if (onlyRequired && got !== full) {
            argFail++;
            report.push(`ARGBIND ${c.name} padded to ${got}, expected ${full} :: ${msg}`);
        }
        if (!onlyRequired && got !== params.length) {
            noDefault++;
            report.push(`NEEDS-ALL ${c.name} (${got}/${params.length} parsed) :: ${msg}`);
        }
    }
}

console.log(`commands: ${actionsList.length}`);
console.log(`parse failures:   ${parseFail}`);
console.log(`arg bind failures:${argFail}`);
console.log(`needs all args:   ${noDefault}  (informational)`);
console.log('\n--- first 25 issues ---');
report.slice(0, 25).forEach(r => console.log('  ' + r));
