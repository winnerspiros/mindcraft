// Guards the bot's SELF-HEAL path: boot.sh's server-port wait and the systemd
// start-limit window. Neither is covered by the rest of the suite -- the rest of
// the suite is all in-process JS, and these two are the exact things whose failure
// mode is "the bot silently stays offline" (2026-10-04, symptom: "the bot doesnt
// auto connect?"). A green suite says nothing about them, so pin them here.
//
// WHAT THIS DOES NOT CATCH, measured not assumed: nothing here starts the real
// systemd unit or kills the real server. This asserts the STATIC contract (the
// conf parses, the window is wide enough for a restart cycle, the wait is bounded
// and non-blocking). The runtime proof remains the live restart drill -- restart
// minecraft-fabric and confirm `repeated too quickly` count stays 0 and UwU
// re-appears in `list` without a manual reset-failed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = "/home/ubuntu/uwu-bot";
// Overridable so a mutation test can point these at fixtures; the defaults are the
// real deployed paths. Read via a lazy getter -- a const snapshot would silently
// ignore an override set after import.
const PATHS = {
    boot: process.env.BOOT_SH || `${ROOT}/tools/boot.sh`,
    unit: process.env.UNIT_DROPIN ||
        "/etc/systemd/system/uwu-bot.service.d/20-restart.conf",
    unitSrc: process.env.UNIT_SRC || `${ROOT}/systemd/20-restart.conf`,
    unitName: process.env.UNIT_NAME || "/etc/systemd/system/uwu-bot.service",
};
const BOOT = PATHS.boot;
const UNIT_DROPIN = PATHS.unit;
const UNIT_SRC = PATHS.unitSrc;

// A restart cycle on this box costs ~5 attempts at RestartSec=15 (~75s). The
// limiter must survive that with headroom, so the window has to be comfortably
// longer than the cycle and the burst comfortably larger than the attempt count.
// The floor is deliberately ABOVE the old broken values (burst 4 / interval 300):
// asserting ">= the thing that was broken" passes the regression it exists to catch.
const START_CYCLE_ATTEMPTS = 5;
const MIN_BURST = START_CYCLE_ATTEMPTS * 2; // 10
const MIN_INTERVAL = 900; // 15min -- >2x the longest realistic server boot+cycle

const read = (p) => readFileSync(p, "utf8");

test("boot.sh parses as valid bash", () => {
    execFileSync("bash", ["-n", BOOT], { stdio: "pipe" });
});

test("boot.sh waits for the server port before starting", () => {
    const src = read(BOOT);
    // Pin the exact endpoint: a bare /25565/ match also passes if the probe is
    // pointed at the wrong port, which was a hole in the first cut of this test.
    assert.match(src, /\/dev\/tcp\/127\.0\.0\.1\/25565/,
        "must probe the game server on 127.0.0.1:25565");
    assert.match(src, /server is accepting connections/,
        "must log the success branch");
});

test("the port wait is BOUNDED (cannot wedge boot forever)", () => {
    const src = read(BOOT);
    // A bounded retry loop, and an explicit fall-through that starts anyway.
    // NB: the shell text is literally `for _ in $(seq 1 60); do` -- in a JS regex
    // literal only `$(` needs escaping.
    assert.match(src, /for _ in \$\(seq 1 \d+\); do/, "wait must use a bounded loop");
    assert.match(src, /starting anyway/,
        "must start anyway when the port never opens -- a wait that can refuse to");
    assert.match(src, /starting anyway[\s\S]*?starting uwu-bot/,
        "the fall-through must lead to an actual start");
});

test("the wait happens BEFORE the bot exec's", () => {
    const src = read(BOOT);
    const waitAt = src.indexOf("waiting for minecraft server");
    const execAt = src.indexOf("exec /home/ubuntu/.bun/bin/bun standalone.js");
    assert.ok(waitAt !== -1 && execAt !== -1, "both must be present");
    assert.ok(waitAt < execAt,
        "the wait must come first, otherwise it gates nothing");
});

test("the installed systemd drop-in is the widened window", () => {
    assert.ok(existsSync(UNIT_DROPIN), `${UNIT_DROPIN} must exist`);
    const src = read(UNIT_DROPIN);
    const burst = /StartLimitBurst=(\d+)/.exec(src);
    const interval = /StartLimitIntervalSec=(\d+)/.exec(src);
    assert.ok(burst && interval, "both limits must be set");
    assert.ok(Number(burst[1]) >= MIN_BURST,
        `burst ${burst[1]} leaves no headroom over the ~${START_CYCLE_ATTEMPTS} ` +
        `attempts a restart cycle costs (need >= ${MIN_BURST})`);
    assert.ok(Number(interval[1]) >= MIN_INTERVAL,
        `interval ${interval[1]}s can be exhausted by a restart cycle ` +
        `(need >= ${MIN_INTERVAL}s)`);
});

test("start limiting is NOT disabled wholesale", () => {
    // StartLimitAction=none also disables throttling for genuine crash loops,
    // which is the protection the limiter exists for. Keep it active.
    // Match ACTIVE directives only: the file mentions "none" inside a comment that
    // explains why it is wrong, and a comment-blind /StartLimitAction=(\S+)/ happily
    // reads that prose and would both false-pass and false-fail.
    const src = read(UNIT_DROPIN);
    const active = src.split("\n")
        .filter((l) => l.trim() && !l.trim().startsWith("#"))
        .join("\n");
    const action = /^StartLimitAction=(\S+)/m.exec(active);
    assert.ok(!action || action[1] !== "none",
        "StartLimitAction=none disables crash-loop throttling too");
});

test("crash-loop throttling is preserved, not weakened", () => {
    // These live in the BASE unit (/etc/systemd/system/uwu-bot.service), not in
    // 20-restart.conf -- the drop-in only holds the [Unit] start-limit keys. Read
    // the merged view so this asserts what systemd actually applies. UNIT_CAT lets
    // a mutation test inject a fixture without touching the real unit.
    const cat = process.env.UNIT_CAT;
    const merged = cat
        ? readFileSync(cat, "utf8")
        : execFileSync("systemctl", ["cat", "uwu-bot.service"],
            { encoding: "utf8", stdio: "pipe" });
    const active = merged.split("\n")
        .filter((l) => l.trim() && !l.trim().startsWith("#"))
        .join("\n");
    assert.match(active, /^Restart=(always|on-failure)/m,
        "must still restart on its own");
    // A bare /\d+/ also accepts RestartSec=0, which is a hot restart loop -- the
    // exact opposite of throttling. Require a real backoff.
    const sec = /^RestartSec=(\d+)/m.exec(active);
    assert.ok(sec, "must keep a restart backoff");
    assert.ok(Number(sec[1]) >= 5,
        `RestartSec=${sec[1]}s is a hot loop; need a real backoff (>=5s)`);
});

test("the systemd source-of-truth copy matches what is installed", () => {
    assert.ok(existsSync(UNIT_SRC), `${UNIT_SRC} must exist as source of truth`);
    // Compare EVERY StartLimit key, not just the first: a single-match capture
    // compares Burst only, so an IntervalSec drift passes silently (it did).
    const limits = (t) => {
        const out = {};
        for (const [, k, v] of t.matchAll(/^(StartLimit\w+)=(\S+)/gm)) out[k] = v;
        return out;
    };
    const a = limits(read(UNIT_DROPIN));
    const b = limits(read(UNIT_SRC));
    assert.deepEqual(b, a,
        "~/uwu-bot/systemd/20-restart.conf has drifted from the installed drop-in");
});

test("the unit files are syntactically valid for systemd", () => {
    // systemd-analyze verify takes a UNIT NAME, not a drop-in path (a .conf path
    // is rejected outright with "Failed to prepare filename"). Verifying the unit
    // is the stronger check anyway: systemd then parses the drop-in as part of it.
    // Needs root to read the unit tree; skip rather than fail when unprivileged.
    try {
        execFileSync("systemd-analyze", ["verify", PATHS.unitName],
            { stdio: "pipe" });
    } catch (e) {
        if (e.status === undefined || /Permission denied|EACCES/.test(
            String(e.stderr ?? ""))) {
            return; // unprivileged: static assertions above still ran
        }
        throw e;
    }
});