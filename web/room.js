// Which mesh a tab belongs to, and the keys that protect a private one.
//
// A tab joins the global mesh unless its URL carries an invite,
// `#mesh=<secret>` (16 random bytes, base64url), optionally followed by
// `&model=<id>`, the model the cluster runs. Three values are derived from
// the secret with HKDF-SHA-256:
//
//   joinToken   sent to the signaling server, which keys the room by its hash.
//               The model id is part of its derivation, so a link whose model
//               was changed or removed opens another, empty room and can
//               never change the model of a running one.
//   historyTag  the scope saved chats are stored under (web/history.js)
//   linkKey     HMAC key that seals every WebRTC offer and answer
//
// The secret, historyTag and linkKey never leave the browser. The global mesh
// is a room with no key: `seal` returns its input and `verify` accepts
// everything. The trust model is in docs/architecture.md (Private meshes).

// Keeps the project's old name: the salt is part of every join token, so
// changing it would break every invite link already shared.
const SALT = 'chattorrent/mesh/v1';
export const SECRET_BYTES = 16;
const SECRET_RE = /^[A-Za-z0-9_-]{22}$/;

// The model a link without `&model=` runs: links made before there was a
// choice. Fixed, not "the server's default", so those links keep their model.
// Its join token is derived exactly as before.
export const LEGACY_MODEL = 'qwen3.8-27b';
const MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,39}$/;

// A version number included in every MAC, so MACs over a different set of
// fields never verify.
const SEAL_V = 1;

const enc = new TextEncoder();

export function b64url(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

// Generate a new invite secret.
export function newSecret() {
    return b64url(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

// The link to share: this page's URL with the fragment set and the query
// removed. The query (`?blocks=`, `?gb=`) holds this tab's own settings.
// `from`, if given, is the inviter's name, shown to whoever opens the link.
// It is not authenticated and plays no part in the keys. `model` is the
// cluster's model id, left out for LEGACY_MODEL's links.
export function inviteUrl(secret, base = globalThis.location, from = '', model = null) {
    const u = new URL(base.href);
    u.search = '';
    const name = cleanName(from);
    u.hash = `mesh=${secret}${model ? `&model=${model}` : ''}`
        + `${name ? `&from=${encodeURIComponent(name)}` : ''}`;
    return u.href;
}

// The longest inviter name kept, in characters.
export const NAME_MAX = 32;

// A display name: control characters removed, spaces collapsed, cut to
// NAME_MAX characters.
export function cleanName(s) {
    return [...String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()]
        .slice(0, NAME_MAX).join('');
}

// The inviter's name in a `location.hash`, or '' when there is none or the
// hash is not an invite.
export function inviteFrom(hash) {
    const m = /^#?mesh=[A-Za-z0-9_-]{22}(?:&model=[^&]*)?&from=([^&]*)$/.exec(hash ?? '');
    if (!m) return '';
    try { return cleanName(decodeURIComponent(m[1])); } catch { return ''; }
}

// The secret in a `location.hash`, or null for the global mesh.
//
// An empty hash is the global mesh. Anything else must be exactly
// `#mesh=<22 base64url characters>`, optionally followed by `&model=<id>`
// and then `&from=<name>`.
// A damaged or mistyped invite throws; it does not fall back to the public
// mesh, where someone expecting a private chat would be exposed.
export function readInvite(hash) {
    const h = (hash ?? '').replace(/^#/, '');
    if (!h) return null;
    const m = INVITE_RE.exec(h);
    if (!m) throw new Error(`the link's "#${h.slice(0, 40)}" is not an invite. Expected #mesh=<code>.`);
    if (!SECRET_RE.test(m[1])) {
        throw new Error('the invite code in this link is damaged. It should be 22 letters, ' +
            'digits, "-" or "_". Ask for the link again.');
    }
    if (m[2] != null && !MODEL_RE.test(m[2])) {
        throw new Error(`the model in this link ("${m[2].slice(0, 40)}") is damaged. Ask for the link again.`);
    }
    return m[1];
}

const INVITE_RE = /^mesh=([^&]*)(?:&model=([^&]*))?(?:&from=[^&]*)?$/;

// The model id in an invite `location.hash`, or null for none (LEGACY_MODEL's
// links and the global mesh). Throws as readInvite() does for a bad link.
export function inviteModel(hash) {
    if (readInvite(hash) == null) return null;
    return INVITE_RE.exec((hash ?? '').replace(/^#/, ''))[2] ?? null;
}

// SHA-256 of a join token, hex. The server keys a room by it. Its first six
// characters are the tag shown in the server's log and on the page, which
// members can compare to confirm they are in the same room.
export async function roomKey(joinToken) {
    return hex(await crypto.subtle.digest('SHA-256', enc.encode(joinToken)));
}

// The fields a MAC covers, serialized as one unambiguous string.
const sealed = ({ kind, from, to, sdp }) =>
    JSON.stringify([SEAL_V, kind, from, to, sdp?.type ?? null, sdp?.sdp ?? null]);

// The global mesh: no token, nothing sealed, everything accepted.
export const GLOBAL = Object.freeze({
    private: false,
    joinToken: null,
    model: null,
    tag: null,
    historyTag: 'global',
    seal: async (signal) => signal,
    verify: async () => true,
});

// A room for this secret, or the global mesh for null.
//
// `model` is the link's model id, null for LEGACY_MODEL. It is mixed into the
// join token and sent with every join (net.js), so after a server restart
// whoever arrives first recreates the room with its model.
//
// `overrideToken` is for the test harness only: it simulates an intruder that
// knows a room's join token (as the server does) but not its secret.
export async function openRoom(secret, { model = null, overrideToken = null } = {}) {
    if (secret == null) return GLOBAL;
    if (!SECRET_RE.test(secret)) throw new Error('not an invite secret');
    if (model === LEGACY_MODEL) model = null;
    if (model != null && !MODEL_RE.test(model)) throw new Error('not a model id');

    const ikm = await crypto.subtle.importKey('raw', unb64url(secret), 'HKDF', false,
        ['deriveBits', 'deriveKey']);
    const hkdf = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(SALT),
                              info: enc.encode(info) });

    const joinToken = overrideToken
        ?? b64url(new Uint8Array(await crypto.subtle.deriveBits(
            hkdf(model ? `join/${model}` : 'join'), ikm, 256)));
    const historyTag = hex(await crypto.subtle.deriveBits(hkdf('history'), ikm, 128));
    const linkKey = await crypto.subtle.deriveKey(hkdf('link'), ikm,
        { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);

    return Object.freeze({
        private: true,
        joinToken,
        model,
        tag: (await roomKey(joinToken)).slice(0, 6),
        historyTag,

        // `signal` is { kind, from, to, sdp }. Returns it with `mac` added.
        async seal(signal) {
            const mac = await crypto.subtle.sign('HMAC', linkKey, enc.encode(sealed(signal)));
            return { ...signal, mac: b64url(new Uint8Array(mac)) };
        },

        // True only if `mac` is this room's MAC over these fields.
        // subtle.verify compares in constant time.
        async verify(signal) {
            if (typeof signal?.mac !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(signal.mac)) {
                return false;
            }
            try {
                return await crypto.subtle.verify('HMAC', linkKey, unb64url(signal.mac),
                    enc.encode(sealed(signal)));
            } catch {
                return false;
            }
        },
    });
}

// --- What a tab that starts a cluster remembers ---
//
// sessionStorage, keyed by the invite secret, so a reload keeps them: that
// this tab started it (the share card says so), and the limits it chose on
// the create page (sent with every join, see net.js's connect()). Storage
// keys keep the project's old name, so a reload finds what was saved.
export const creatorKey = (s) => `chattorrent:creator:${s}`;
export const chatsKey = (s) => `chattorrent:chats:${s}`;
export const sessionsKey = (s) => `chattorrent:sessions:${s}`;
export const ctxKey = (s) => `chattorrent:ctx:${s}`;

// The name this tab puts on its invite links for one cluster
// (sessionStorage, keyed by the secret). Not kept across clusters or visits,
// so someone arriving through a link starts with an empty name.
export const nameKey = (s) => `chattorrent:name:${s}`;
