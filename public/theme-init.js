(function () {
    // 1. Synchronously set theme before first paint to eliminate any theme flash
    try {
        var stored = localStorage.getItem('ripcord.theme');
        document.documentElement.dataset.theme = (stored === 'light' || stored === 'dark')
            ? stored
            : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    } catch (e) {
        document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    // 2. Set dynamic greeting on first paint
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

    // 3. Mark fonts ready as soon as document.fonts signals or on immediate fallback
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () {
            document.documentElement.classList.add('fonts-ready');
        });
    } else {
        document.documentElement.classList.add('fonts-ready');
    }
})();
