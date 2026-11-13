// Android app glue. Only does anything when running inside the Capacitor shell.
const Native = {
  cap: window.Capacitor,
  get on() { return !!this.cap?.isNativePlatform?.(); },
  get plugins() { return this.cap?.Plugins || {}; },

  start() {
    if (!this.on) return;
    document.documentElement.classList.add('native');
  },

  openExternal(url) {
    const { Browser } = this.plugins;
    if (Browser) Browser.open({ url: new URL(url, location.href).href });
    else window.open(url, '_blank');
  },
};

document.addEventListener('click', e => {
  if (!Native.on) return;
  const a = e.target.closest('a[href]');
  if (!a) return;
  if (a.target === '_blank') {
    e.preventDefault();
    e.stopPropagation();
    Native.openExternal(a.getAttribute('href'));
  }
}, true);
