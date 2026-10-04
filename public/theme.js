try {
    const theme = localStorage.getItem('ripcord.theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch (e) { }