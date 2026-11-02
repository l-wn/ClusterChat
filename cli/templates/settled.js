// The part of a growing reply that will not change: everything but trailing
// whitespace (more text may follow it, or the reply may end and drop it) and
// trailing U+FFFD. The reply is decoded whole each token, and a character
// split across tokens decodes as U+FFFD until its last byte arrives.
export const settled = (text) => text.replace(/[\s\uFFFD]+$/, '');
