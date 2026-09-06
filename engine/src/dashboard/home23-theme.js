/* Local appearance preference only; independent of dashboard and chat state. */
(() => {
  const key = 'home23.appearance';
  const root = document.documentElement;
  const normalize = (value) => value === 'dark' ? 'dark' : 'light';
  function apply(value) {
    const theme = normalize(value);
    root.dataset.theme = theme;
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      const next = theme === 'light' ? 'dark' : 'light';
      button.textContent = `${next === 'dark' ? 'Dark' : 'Light'} mode`;
      button.setAttribute('aria-label', `Switch to ${next} theme`);
    });
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      'content', theme === 'light' ? '#f3f5f8' : '#0a0908',
    );
  }
  let initial = 'light';
  try { initial = normalize(localStorage.getItem(key)); } catch { /* Storage can be unavailable. */ }
  apply(initial);
  document.addEventListener('DOMContentLoaded', () => apply(root.dataset.theme));
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('[data-theme-toggle]')) return;
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    apply(next);
    try { localStorage.setItem(key, next); } catch { /* The current page still switches. */ }
  });
  window.addEventListener('storage', (event) => {
    if (event.key === key || event.key === null) apply(event.newValue);
  });
})();
