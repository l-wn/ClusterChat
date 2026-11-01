// Tests web/lend.js's slider: the range it offers, the "no limit" stop past
// the top, and set() bringing a value in from elsewhere without calling back.
// The slider is pure DOM plus a callback, so four stub elements are enough.
//
//   node tools/lend.test.mjs

import { lendSlider, limitGb, MAX_GB, DEFAULT_GB } from '../web/lend.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
    if (got === want) { pass++; console.log(`  ok    ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

// The least DOM lendSlider() touches: text, a width, some attributes, a class
// list, and keydown/pointer listeners it never has to receive here.
const el = () => ({
    textContent: '',
    style: {},
    attrs: {},
    classes: new Set(),
    keydown: null,
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(type, fn) { if (type === 'keydown') this.keydown = fn; },
    focus() {},
    getBoundingClientRect() { return { left: 0, width: 100 }; },
    classList: { add(c) { this.owner.classes.add(c); }, remove(c) { this.owner.classes.delete(c); } },
});
const wire = (opts = {}) => {
    const bar = el(), fill = el(), handle = el(), out = el();
    bar.classList.owner = bar;
    const seen = [];
    const slider = lendSlider({ bar, fill, handle, out, onChange: (gb) => seen.push(gb), ...opts });
    const key = (k) => handle.keydown({ key: k, preventDefault() {} });
    return { slider, bar, fill, handle, out, seen, key };
};

console.log('\nthe pre-join slider: 0 to MAX_GB, 0 meaning "do not lend"');
{
    const { slider, out, fill, key } = wire({ value: DEFAULT_GB });
    eq('starts at the value given', slider.value, DEFAULT_GB);
    eq('shows it', out.textContent, `${DEFAULT_GB} GB`);
    eq('fills to its share of the track', fill.style.width, `${(DEFAULT_GB / MAX_GB) * 100}%`);
    key('Home');
    eq('Home is none', slider.value, 0);
    eq('and says so', out.textContent, 'None');
    key('End');
    eq('End is the top', slider.value, MAX_GB);
    key('ArrowRight');
    eq('and does not go past it', slider.value, MAX_GB);
    key('PageDown');
    eq('PageDown steps by four', slider.value, MAX_GB - 4);
}

console.log('\nthe drawer slider: lo = 1, and one stop past the top for "no limit"');
{
    const { slider, out, handle, key } = wire({ lo: 1, open: true, value: 8 });
    eq('the top of the range is one past MAX_GB', handle.attrs['aria-valuemax'], String(MAX_GB + 1));
    eq('and the bottom is lo', handle.attrs['aria-valuemin'], '1');
    eq('starts where it was told', slider.value, 8);
    key('Home');
    eq('Home is the lowest offered, not zero', slider.value, 1);
    key('End');
    eq('End is no limit', slider.value, Infinity);
    eq('and says so', out.textContent, 'No limit');
    eq('read out as no limit too', handle.attrs['aria-valuetext'], 'no limit');
    key('ArrowLeft');
    eq('stepping back off it lands on MAX_GB', slider.value, MAX_GB);
    eq('shown in GB again', out.textContent, `${MAX_GB} GB`);
}

console.log('\nInfinity in, Infinity out');
{
    const { slider, out } = wire({ lo: 1, open: true, value: Infinity });
    eq('an unlimited starting value reaches the top stop', slider.value, Infinity);
    eq('shown as no limit', out.textContent, 'No limit');
}
{
    const { slider } = wire({ lo: 1, value: Infinity });
    eq('without `open` it clamps to MAX_GB instead', slider.value, MAX_GB);
}

console.log('\nset() brings a value in from elsewhere and does not call back');
{
    const { slider, out, seen, key } = wire({ lo: 1, open: true, value: 4 });
    slider.set(12);
    eq('the knob moves', slider.value, 12);
    eq('the label follows', out.textContent, '12 GB');
    eq('and onChange is not called', seen.length, 0);
    slider.set(Infinity);
    eq('Infinity reaches the top stop', slider.value, Infinity);
    slider.set(0);
    eq('below the lowest offered is clamped', slider.value, 1);
    key('ArrowRight');
    eq('a real change still calls back', seen.join(), '2');
}

console.log('\nlock() pins it to the low end for good');
{
    const { slider, bar, key } = wire({ value: 8 });
    slider.lock();
    eq('locked to none', slider.value, 0);
    eq('and marked', bar.classes.has('locked'), true);
    key('End');
    eq('keys do nothing after', slider.value, 0);
    slider.set(16);
    eq('nor does set()', slider.value, 0);
}

console.log('\nlimitGb reads back what the slider wrote');
eq('"8gb"', limitGb('8gb'), 8);
eq('"8 GiB"', limitGb('8 GiB'), 8);
eq('blank is no limit, reported as null', limitGb(''), null);
eq('and so is nonsense', limitGb('lots'), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
