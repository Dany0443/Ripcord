// frontend logic for ripcord
// handles fetching track metadata, showing screens, and downloading audio

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const root = document.documentElement;
const body = document.body;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

const el = {
    url: $('#url'),
    search: $('#search'),
    help: $('#url-help'),
    form: $('#fetch-form'),
    fetchBtn: $('#fetch-btn'),
    fetchIcon: $('#fetch-icon'),
    fetchLabel: $('#fetch-label'),
    pasteBtn: $('#paste-btn'),
    pasteIcon: $('#paste-icon'),
    recent: $('#recent'),
    recentList: $('#recent-list'),
    cover: $('#cover'),
    coverImg: $('#cover-img'),
    badge: $('#media-badge'),
    badgeText: $('#media-badge-text'),
    mediaTitle: $('#media-title'),
    mediaArtist: $('#media-artist'),
    formatHint: $('#format-hint'),
    qualityGroup: $('#quality-group'),
    bitrate: $('#bitrate'),
    bitrateOut: $('#bitrate-out'),
    clean: $('#clean'),
    nameGroup: $('#name-group'),
    filename: $('#filename'),
    ext: $('#ext'),
    spotifyNote: $('#spotify-note'),
    backBtn: $('#back-btn'),
    downloadBtn: $('#download-btn'),
    downloadLabel: $('#download-label'),
    workingTitle: $('#working-title'),
    wavy: $('#wavy'),
    metaLeft: $('#meta-left'),
    metaRight: $('#meta-right'),
    workingHint: $('#working-hint'),
    cancelBtn: $('#cancel-btn'),
    doneTitle: $('#done-title'),
    doneSub: $('#done-sub'),
    doneBurst: $('#done-burst'),
    againBtn: $('#again-btn'),
    saveBtn: $('#save-btn'),
    snackbar: $('#snackbar'),
    snackbarText: $('#snackbar-text'),
    snackbarClose: $('#snackbar-close'),
    themeBtn: $('#theme-btn'),
    themeIcon: $('#theme-icon'),
    aboutBtn: $('#about-btn'),
    aboutClose: $('#about-close'),
    about: $('#about'),
    greeting: $('#greeting')
};

const state = {
    stage: 'input',
    info: null,
    url: '',
    xhr: null,
    blob: null,
    blobName: '',
    timer: 0,
    startedAt: 0
};

const BITRATES = [128, 192, 320];
const LOSSLESS = new Set(['flac', 'wav']);
const FORMAT_HINTS = {
    mp3: 'Plays everywhere. A good default.',
    m4a: 'Small and clean, lovely on Apple devices.',
    flac: 'A lossless container. The source audio is still lossy, so expect the same sound in a bigger file.',
    wav: 'Uncompressed and big. Same note as FLAC about the source.',
    ogg: 'Open format with good quality at small sizes.'
};

// small helper functions

const store = {
    get(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch {
            return fallback;
        }
    },
    set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be blocked */ }
    }
};

function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = String(Math.floor(sec % 60)).padStart(2, '0');
    return `${m}:${s}`;
}

function formatMB(bytes) {
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

function safeName(text) {
    return String(text).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '').replace(/\s+/g, ' ').trim();
}

// strip out bracketed words like official video from titles
const JUNK = /\s*[([][^)\]]*\b(official|video|audio|lyrics?|remaster(ed)?|hd|4k|visuali[sz]er|explicit)\b[^)\]]*[)\]]/gi;

function tidyTitle(title) {
    const cleaned = title.replace(JUNK, '').replace(/\s{2,}/g, ' ').trim();
    return cleaned || title;
}

function normaliseUrl(raw) {
    let value = raw.trim();
    if (!value) return null;
    if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        return null;
    }
    const host = parsed.hostname.replace(/^www\./, '');
    const ok = ['youtube.com', 'music.youtube.com', 'm.youtube.com', 'youtu.be', 'open.spotify.com', 'spotify.com']
        .some(h => host === h || host.endsWith('.' + h));
    return ok ? parsed.href : null;
}

function coverSrc(url) {
    return url ? `/api/cover?url=${encodeURIComponent(url)}` : '';
}

// ripple effect when clicking buttons

document.addEventListener('pointerdown', event => {
    const target = event.target.closest('.btn, .icon-btn, .list-item');
    if (!target || target.disabled) return;
    const rect = target.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2;
    const dot = document.createElement('span');
    dot.className = 'ripple';
    dot.style.width = dot.style.height = `${size}px`;
    dot.style.left = `${event.clientX - rect.left - size / 2}px`;
    dot.style.top = `${event.clientY - rect.top - size / 2}px`;
    target.append(dot);
    dot.addEventListener('animationend', () => dot.remove(), { once: true });
});

// slightly move the background blobs when moving the mouse

let parallaxQueued = false;
addEventListener('pointermove', event => {
    if (parallaxQueued || reduceMotion.matches) return;
    parallaxQueued = true;
    requestAnimationFrame(() => {
        parallaxQueued = false;
        root.style.setProperty('--px', ((event.clientX / innerWidth) - 0.5).toFixed(3));
        root.style.setProperty('--py', ((event.clientY / innerHeight) - 0.5).toFixed(3));
    });
}, { passive: true });

// extract theme colors from the album cover art

const TOKENS = {
    primary: 'primary', onPrimary: 'on-primary',
    primaryContainer: 'primary-container', onPrimaryContainer: 'on-primary-container',
    secondary: 'secondary', onSecondary: 'on-secondary',
    secondaryContainer: 'secondary-container', onSecondaryContainer: 'on-secondary-container',
    tertiary: 'tertiary', onTertiary: 'on-tertiary',
    tertiaryContainer: 'tertiary-container', onTertiaryContainer: 'on-tertiary-container',
    error: 'error', onError: 'on-error',
    errorContainer: 'error-container', onErrorContainer: 'on-error-container',
    surface: 'surface', onSurface: 'on-surface', onSurfaceVariant: 'on-surface-variant',
    surfaceDim: 'surface-dim', surfaceBright: 'surface-bright',
    surfaceContainerLowest: 'surface-container-lowest', surfaceContainerLow: 'surface-container-low',
    surfaceContainer: 'surface-container', surfaceContainerHigh: 'surface-container-high',
    surfaceContainerHighest: 'surface-container-highest',
    outline: 'outline', outlineVariant: 'outline-variant',
    inverseSurface: 'inverse-surface', inverseOnSurface: 'inverse-on-surface',
    inversePrimary: 'inverse-primary'
};

const DEFAULT_SEED = 0xFFE0782B;
let mcu = null;
let seed = DEFAULT_SEED;

async function loadColourEngine() {
    try {
        mcu = await import('./vendor/mcu.js');
        // register color properties so theme changes transition smoothly
        for (const name of Object.values(TOKENS)) {
            try {
                CSS.registerProperty({ name: `--md-sys-color-${name}`, syntax: '<color>', inherits: true, initialValue: 'transparent' });
            } catch { /* already registered */ }
        }
        applyScheme();
        // enable transitions only after the page paints so it does not flash on load
        requestAnimationFrame(() => {
            setTimeout(() => {
                root.style.transition = Object.values(TOKENS)
                    .map(n => `--md-sys-color-${n} 0.8s ease`).join(', ');
            }, 150);
        });
    } catch {
        mcu = null;
    }
}

function isDarkNow() {
    const chosen = root.dataset.theme;
    if (chosen) return chosen === 'dark';
    return matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyScheme() {
    if (!mcu) return;
    // remove custom colors if we are back to the default theme
    if (seed === DEFAULT_SEED) {
        for (const name of Object.values(TOKENS)) root.style.removeProperty(`--md-sys-color-${name}`);
    } else {
        const scheme = new mcu.SchemeTonalSpot(mcu.Hct.fromInt(seed), isDarkNow(), 0);
        for (const [prop, name] of Object.entries(TOKENS)) {
            const color = mcu.MaterialDynamicColors[prop];
            if (color) root.style.setProperty(`--md-sys-color-${name}`, mcu.hexFromArgb(color.getArgb(scheme)));
        }
    }
    syncThemeColorMeta();
}

function syncThemeColorMeta() {
    const surface = getComputedStyle(root).getPropertyValue('--md-sys-color-surface').trim();
    if (!surface) return;
    $$('meta[name="theme-color"]').forEach(meta => {
        meta.removeAttribute('media');
        meta.content = surface;
    });
}

async function seedFromCover() {
    if (!mcu) return;
    try {
        if (!el.coverImg.complete || !el.coverImg.naturalWidth) await el.coverImg.decode();
        seed = await mcu.sourceColorFromImage(el.coverImg);
    } catch {
        seed = DEFAULT_SEED;
    }
    applyScheme();
}

function resetSeed() {
    if (seed === DEFAULT_SEED) return;
    seed = DEFAULT_SEED;
    applyScheme();
}

// toggle between dark and light mode

const THEMES = [
    { id: 'auto', icon: 'brightness_auto', label: 'Theme: automatic' },
    { id: 'light', icon: 'light_mode', label: 'Theme: light' },
    { id: 'dark', icon: 'dark_mode', label: 'Theme: dark' }
];

function currentThemeId() {
    return root.dataset.theme || 'auto';
}

function renderThemeButton() {
    const t = THEMES.find(x => x.id === currentThemeId());
    el.themeIcon.textContent = t.icon;
    el.themeBtn.setAttribute('aria-label', t.label);
}

el.themeBtn.addEventListener('click', () => {
    const next = THEMES[(THEMES.findIndex(x => x.id === currentThemeId()) + 1) % THEMES.length];
    if (next.id === 'auto') {
        delete root.dataset.theme;
        try { localStorage.removeItem('ripcord.theme'); } catch { /* ignore */ }
    } else {
        root.dataset.theme = next.id;
        try { localStorage.setItem('ripcord.theme', next.id); } catch { /* ignore */ }
    }
    renderThemeButton();
    applyScheme();
    toast(next.label.replace('Theme: ', 'Theme set to ') + '.');
});

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!root.dataset.theme) applyScheme();
});

// show a small notification toast at the bottom

let toastTimer = 0;
function toast(message, ms = 1000) {
    el.snackbarText.textContent = message;
    el.snackbar.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.snackbar.classList.remove('show'), ms);
}
el.snackbarClose.addEventListener('click', () => el.snackbar.classList.remove('show'));

// open and close the about dialog

el.aboutBtn.addEventListener('click', () => el.about.showModal());
el.aboutClose.addEventListener('click', () => el.about.close());
el.about.addEventListener('click', event => {
    if (event.target === el.about) el.about.close();
});

// spin the vinyl record cover while loading

let spin = null;
function setupSpin() {
    if (reduceMotion.matches || !el.cover.animate) return;
    const opts = { duration: 48000, iterations: Infinity, easing: 'linear' };
    const outer = el.cover.animate([{ rotate: '0deg' }, { rotate: '360deg' }], opts);
    const inner = el.coverImg.animate([{ rotate: '0deg' }, { rotate: '-360deg' }], opts);
    spin = [outer, inner];
}

function setSpinSpeed(rate) {
    if (!spin) return;
    spin.forEach(a => a.updatePlaybackRate(rate));
}

// switch between the different screens

const FOCUS_TARGET = {
    input: '#url',
    options: '#media-title',
    working: '#working-title',
    done: '#done-title'
};

function go(stage, dir = 'forward') {
    const apply = () => {
        state.stage = stage;
        body.dataset.stage = stage;
    };
    const after = () => {
        const target = $(FOCUS_TARGET[stage]);
        if (target) target.focus({ preventScroll: true });
    };

    root.dataset.dir = dir;
    if (document.startViewTransition && !reduceMotion.matches) {
        const vt = document.startViewTransition(apply);
        vt.finished.finally(after);
    } else {
        apply();
        after();
    }
    setSpinSpeed(stage === 'working' ? 4 : 1);
}

// change the greeting based on the time of day

function setGreeting() {
    const h = new Date().getHours();
    let text = 'Good evening';
    if (h < 5) text = 'Up late? Same';
    else if (h < 12) text = 'Good morning';
    else if (h < 18) text = 'Good afternoon';
    el.greeting.textContent = text;
}

// logic for the search input box and paste button

function setFieldError(message) {
    const bad = Boolean(message);
    el.search.dataset.invalid = String(bad);
    el.help.dataset.error = String(bad);
    el.help.textContent = message || 'Spotify, YouTube or YouTube Music links work.';
    el.url.setAttribute('aria-invalid', String(bad));
    if (bad) {
        // shake the input box if the url is invalid
        el.search.style.animation = 'none';
        void el.search.offsetWidth;
        el.search.style.animation = '';
    }
}

function syncPasteButton() {
    const has = el.url.value.length > 0;
    el.pasteIcon.textContent = has ? 'close' : 'content_paste';
    el.pasteBtn.setAttribute('aria-label', has ? 'Clear' : 'Paste from clipboard');
    el.pasteBtn.title = has ? 'Clear' : 'Paste';
}

el.url.addEventListener('input', () => {
    syncPasteButton();
    if (el.search.dataset.invalid === 'true') setFieldError('');
});

el.pasteBtn.addEventListener('click', async () => {
    if (el.url.value) {
        el.url.value = '';
        syncPasteButton();
        setFieldError('');
        el.url.focus();
        return;
    }
    try {
        const text = await navigator.clipboard.readText();
        if (text) {
            el.url.value = text.trim();
            syncPasteButton();
            submitUrl();
        }
    } catch {
        toast('Could not read the clipboard. Press Ctrl+V in the box instead.');
        el.url.focus();
    }
});

// automatically start searching if the user pastes anywhere on the page
document.addEventListener('paste', event => {
    if (state.stage !== 'input' || document.activeElement === el.url) return;
    const text = event.clipboardData?.getData('text');
    if (!text) return;
    el.url.value = text.trim();
    syncPasteButton();
    submitUrl();
});

el.url.addEventListener('paste', () => {
    // wait a tick so the pasted text is actually in the box
    setTimeout(() => { if (normaliseUrl(el.url.value)) submitUrl(); }, 0);
});

el.form.addEventListener('submit', event => {
    event.preventDefault();
    submitUrl();
});

function setFetching(on) {
    el.fetchBtn.disabled = on;
    el.fetchIcon.textContent = on ? 'progress_activity' : 'arrow_forward';
    el.fetchIcon.classList.toggle('spin', on);
    el.fetchLabel.textContent = on ? 'Looking it up' : 'Continue';
}

let fetching = false;
async function submitUrl() {
    if (fetching) return;
    const url = normaliseUrl(el.url.value);
    if (!url) {
        setFieldError(el.url.value.trim()
            ? 'That does not look like a Spotify or YouTube link.'
            : 'Paste a link first.');
        el.url.focus();
        return;
    }
    setFieldError('');
    fetching = true;
    setFetching(true);
    try {
        const res = await fetch(`/api/fetch-info?url=${encodeURIComponent(url)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
        state.url = url;
        state.info = data;
        showOptions();
        remember(url, data);
    } catch (err) {
        setFieldError(err.message);
    } finally {
        fetching = false;
        setFetching(false);
    }
}

// show recently downloaded songs

function remember(url, info) {
    const list = store.get('ripcord.recent', []).filter(r => r.url !== url);
    list.unshift({ url, title: info.title, artist: info.artist || '', thumbnail: info.thumbnail || '', type: info.type });
    store.set('ripcord.recent', list.slice(0, 3));
    renderRecent();
}

function renderRecent() {
    const list = store.get('ripcord.recent', []);
    el.recent.hidden = list.length === 0;
    el.recentList.replaceChildren();
    for (const item of list) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'list-item';

        if (item.thumbnail) {
            const img = document.createElement('img');
            img.alt = '';
            img.width = img.height = 48;
            img.loading = 'lazy';
            img.src = coverSrc(item.thumbnail);
            img.onerror = () => { img.onerror = null; img.src = item.thumbnail; };
            btn.append(img);
        } else {
            const icon = document.createElement('span');
            icon.className = 'icon';
            icon.textContent = 'music_note';
            btn.append(icon);
        }

        const text = document.createElement('span');
        text.className = 'list-item__text';
        const strong = document.createElement('strong');
        strong.textContent = item.title;
        const small = document.createElement('small');
        small.textContent = item.artist || (item.type === 'collection' ? 'Collection' : '');
        text.append(strong, small);
        btn.append(text);

        btn.addEventListener('click', () => {
            el.url.value = item.url;
            syncPasteButton();
            submitUrl();
        });
        li.append(btn);
        el.recentList.append(li);
    }
}

// options screen where the user picks format and quality

function currentFormat() {
    return $('input[name="format"]:checked').value;
}

function currentNameStyle() {
    return $('input[name="namestyle"]:checked').value;
}

function suggestedName() {
    const info = state.info;
    if (!info) return '';
    const title = el.clean.checked ? tidyTitle(info.title) : info.title;
    const artist = info.artist || '';
    let name = title;
    if (info.type !== 'collection' && artist) {
        const style = currentNameStyle();
        if (style === 'title_artist') name = `${title} - ${artist}`;
        if (style === 'artist_title') name = `${artist} - ${title}`;
    }
    return safeName(name);
}

let nameTouched = false;
function refreshName() {
    if (!nameTouched) el.filename.value = suggestedName();
}

function refreshFormat() {
    const fmt = currentFormat();
    const lossless = LOSSLESS.has(fmt);
    el.ext.textContent = `.${fmt}`;
    el.formatHint.textContent = FORMAT_HINTS[fmt];
    el.qualityGroup.dataset.disabled = String(lossless);
    el.bitrate.disabled = lossless;
    el.bitrateOut.textContent = lossless ? 'Lossless' : `${BITRATES[el.bitrate.value]} kbps`;
}

function refreshSlider() {
    const pct = (el.bitrate.value / (el.bitrate.max - el.bitrate.min)) * 100;
    el.bitrate.style.setProperty('--fill', `${pct}%`);
    el.bitrateOut.textContent = LOSSLESS.has(currentFormat()) ? 'Lossless' : `${BITRATES[el.bitrate.value]} kbps`;
}

$$('input[name="format"]').forEach(i => i.addEventListener('change', refreshFormat));
$$('input[name="namestyle"]').forEach(i => i.addEventListener('change', () => { nameTouched = false; refreshName(); }));
el.clean.addEventListener('change', () => { nameTouched = false; refreshName(); });
el.bitrate.addEventListener('input', refreshSlider);
el.filename.addEventListener('input', () => { nameTouched = true; });

function showOptions() {
    const info = state.info;
    const isCollection = info.type === 'collection';
    const isSpotify = /spotify\.com/i.test(state.url);

    // fill in the title and cover art before showing the screen
    el.mediaTitle.textContent = info.title;
    el.mediaArtist.textContent = isCollection
        ? `${info.trackCount} ${info.trackCount === 1 ? 'track' : 'tracks'}`
        : (info.artist || '');
    el.badgeText.textContent = isCollection ? 'Collection' : 'Track';
    $('.icon', el.badge).textContent = isCollection ? 'library_music' : 'music_note';

    el.coverImg.onerror = () => {
        el.coverImg.onerror = null;
        el.coverImg.src = info.thumbnail || '';
    };
    el.coverImg.onload = () => seedFromCover();
    el.coverImg.crossOrigin = 'anonymous';
    el.coverImg.src = info.thumbnail ? coverSrc(info.thumbnail) : '';
    if (!info.thumbnail) resetSeed();

    el.spotifyNote.hidden = !isSpotify;
    el.nameGroup.style.display = isCollection ? 'none' : '';
    $$('input[name="namestyle"]').forEach(i => { i.disabled = isCollection; });
    $('input[name="namestyle"][value="title"]').checked = true;
    nameTouched = false;
    refreshName();
    refreshFormat();
    refreshSlider();

    el.downloadLabel.textContent = isCollection
        ? `Download ${info.trackCount} tracks as ZIP`
        : 'Download';

    go('options', 'forward');
}

el.backBtn.addEventListener('click', () => {
    resetSeed();
    go('input', 'back');
});

// handle starting the download

function startDownload() {
    const info = state.info;
    const isCollection = info.type === 'collection';
    const fmt = currentFormat();
    const bitrate = LOSSLESS.has(fmt) ? 320 : BITRATES[el.bitrate.value];
    const name = safeName(el.filename.value) || suggestedName() || 'ripcord';

    const params = new URLSearchParams({ url: state.url, bitrate: String(bitrate), format: fmt, filename: name });
    const saveName = isCollection ? `${safeName(info.title) || 'ripcord'}.zip` : `${name}.${fmt}`;

    el.workingTitle.textContent = isCollection ? 'Packing up your collection' : 'Pulling the sound out';
    el.metaLeft.textContent = 'Getting started';
    el.metaRight.textContent = '0:00';
    el.wavy.dataset.indeterminate = 'true';
    el.wavy.style.removeProperty('--p');
    el.wavy.removeAttribute('aria-valuenow');
    el.workingHint.textContent = isCollection
        ? 'Collections are prepared track by track, so this can take a few minutes. You can leave this tab open.'
        : 'Finding the audio and converting it. Usually under a minute.';

    state.startedAt = Date.now();
    clearInterval(state.timer);
    state.timer = setInterval(() => {
        el.metaRight.textContent = formatTime((Date.now() - state.startedAt) / 1000);
    }, 500);

    const xhr = new XMLHttpRequest();
    state.xhr = xhr;
    xhr.open('GET', `/api/download?${params}`);
    xhr.responseType = 'blob';

    xhr.onprogress = event => {
        if (event.loaded === 0) return;
        if (event.lengthComputable && event.total > 0) {
            const pct = Math.min(100, Math.round((event.loaded / event.total) * 100));
            el.wavy.dataset.indeterminate = 'false';
            el.wavy.style.setProperty('--p', `${pct}%`);
            el.wavy.setAttribute('aria-valuenow', String(pct));
            el.metaLeft.textContent = `${pct}% - ${formatMB(event.loaded)} of ${formatMB(event.total)}`;
        } else {
            // show how many megabytes have been downloaded so far
            el.metaLeft.textContent = `${formatMB(event.loaded)} received`;
        }
    };

    xhr.onload = async () => {
        stopTimer();
        if (xhr.status >= 200 && xhr.status < 300) {
            state.blob = xhr.response;
            state.blobName = saveName;
            saveBlob();
            finish(isCollection);
        } else {
            let message = 'The download failed. Please try again.';
            try {
                const data = JSON.parse(await xhr.response.text());
                if (data.error) message = data.error;
            } catch { /* keep the generic message */ }
            fail(message);
        }
    };
    xhr.onerror = () => { stopTimer(); fail('Lost the connection. Check your network and try again.'); };
    xhr.onabort = () => { stopTimer(); };

    xhr.send();
    go('working', 'forward');
}

function stopTimer() {
    clearInterval(state.timer);
    state.timer = 0;
}

function saveBlob() {
    if (!state.blob) return;
    const href = URL.createObjectURL(state.blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = state.blobName;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60000);
}

function fail(message) {
    state.xhr = null;
    toast(message, 6500);
    go('options', 'back');
}

function finish(isCollection) {
    state.xhr = null;
    el.doneSub.textContent = isCollection
        ? 'Your ZIP should be in your downloads folder.'
        : 'Your file should be in your downloads folder.';
    go('done', 'forward');
    celebrate();
}

function celebrate() {
    el.doneBurst.replaceChildren();
    if (reduceMotion.matches) return;
    const glyphs = ['music_note', 'music_note', 'queue_music', 'graphic_eq', 'favorite'];
    for (let i = 0; i < 9; i++) {
        const n = document.createElement('span');
        n.className = 'icon fill note';
        n.textContent = glyphs[i % glyphs.length];
        n.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 300)}px`);
        n.style.setProperty('--rot', `${Math.round((Math.random() - 0.5) * 80)}deg`);
        n.style.animationDelay = `${i * 70}ms`;
        el.doneBurst.append(n);
    }
}

el.downloadBtn.addEventListener('click', startDownload);
el.cancelBtn.addEventListener('click', () => {
    if (state.xhr) state.xhr.abort();
    state.xhr = null;
    toast('Cancelled.');
    go('options', 'back');
});
el.saveBtn.addEventListener('click', saveBlob);
el.againBtn.addEventListener('click', () => {
    state.blob = null;
    state.info = null;
    el.url.value = '';
    syncPasteButton();
    setFieldError('');
    resetSeed();
    go('input', 'back');
});

// start everything up when the page loads

setGreeting();
renderThemeButton();
renderRecent();
syncPasteButton();
setupSpin();
syncThemeColorMeta();
loadColourEngine();
