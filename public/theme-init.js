(function () {
    var root = document.documentElement;

    // 1. Synchronously set theme before first paint to eliminate any theme flash
    try {
        var stored = localStorage.getItem('ripcord.theme');
        root.dataset.theme = (stored === 'light' || stored === 'dark')
            ? stored
            : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    } catch (e) {
        root.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    // 2. Full intro on first visit of a session; short intro on repeat loads
    var introMode = 'full';
    try {
        if (sessionStorage.getItem('ripcord.intro') === '1') {
            introMode = 'short';
        } else {
            sessionStorage.setItem('ripcord.intro', '1');
        }
    } catch (e) {
        introMode = 'full';
    }
    root.dataset.intro = introMode;

    // 3. Set dynamic greeting on first paint
    var h = new Date().getHours();
    var greetingText = h < 5 ? 'Up late? Same' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            var el = document.getElementById('greeting');
            if (el) el.textContent = greetingText;
        }, { once: true });
    } else {
        var el = document.getElementById('greeting');
        if (el) el.textContent = greetingText;
    }

    // 4. Mark fonts ready as soon as document.fonts signals (with short safety cap)
    var markReady = function () {
        root.classList.add('fonts-ready');
    };
    if (document.fonts && document.fonts.ready) {
        if (document.fonts.status === 'loaded') {
            markReady();
        } else {
            document.fonts.ready.then(markReady);
            setTimeout(markReady, 300);
        }
    } else {
        markReady();
    }
})();
