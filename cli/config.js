// What this machine chose for each cluster: whether to lend its GPU and how
// much. Kept in $XDG_CONFIG_HOME/clusterchat/clusters.json (or
// ~/.config/clusterchat), readable by this user only, and keyed by a hash of
// the invite, so the file never holds a cluster's secret.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'clusterchat');
const FILE = join(DIR, 'clusters.json');

// The key for a target from join.js's parseTarget().
export const clusterKey = (target) => createHash('sha256')
    .update(target.demo ? `demo ${target.server}` : `${target.server}${target.hash}`).digest('hex').slice(0, 24);

function readAll() {
    try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return {}; }
}

// { lend: boolean, gb: number | null } or null if this cluster was never asked.
export function savedChoice(target) {
    return readAll()[clusterKey(target)] ?? null;
}

// Never throws: a choice that cannot be kept is asked again next time.
export function saveChoice(target, choice) {
    try {
        const all = readAll();
        all[clusterKey(target)] = { ...choice, at: new Date().toISOString() };
        mkdirSync(DIR, { recursive: true, mode: 0o700 });
        writeFileSync(FILE, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
    } catch { /* asked again next time */ }
}
