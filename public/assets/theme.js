/**
 * Тема. Файл подключён синхронно в <head> и выполняется до первой отрисовки —
 * иначе тёмная тема мигнула бы светлым фоном. Отдельным файлом, а не инлайном,
 * чтобы CSP обходилась без 'unsafe-inline' для скриптов.
 */
(function () {
  var KEY = 'viferon-dash-theme';

  try {
    var saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  } catch (e) {}

  /** Переключатель в шапке: система → светлая → тёмная → система. */
  window.bindThemeToggle = function (button) {
    if (!button) return;
    button.addEventListener('click', function () {
      var current = document.documentElement.dataset.theme;
      var system = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      var next = current === '' ? (system === 'dark' ? 'light' : 'dark') : current === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem(KEY, next); } catch (e) {}
      button.setAttribute('aria-label', next === 'dark' ? 'Светлая тема' : 'Тёмная тема');
    });
  };
})();
