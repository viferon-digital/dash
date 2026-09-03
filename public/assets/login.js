/**
 * Страница входа. Два способа, оба заканчиваются одной и той же сессией:
 *
 *  · почта и пароль — POST /api/auth/login;
 *  · кнопка Google  — Google Identity Services отдаёт подписанный ID-токен,
 *    он уходит в POST /api/auth/google, где проверяется на сервере.
 *
 * Кнопка Google появляется, только если в окружении задан GOOGLE_CLIENT_ID:
 * страница спрашивает об этом у /api/auth/me.
 */

const form = document.getElementById('form');
const email = document.getElementById('email');
const password = document.getElementById('password');
const submit = document.getElementById('submit');
const error = document.getElementById('error');
const googleBlock = document.getElementById('google-block');

const next = safeNext(new URLSearchParams(location.search).get('next'));

init();

async function init() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    const data = await res.json();

    if (data.authenticated) {
      location.replace(next);
      return;
    }
    if (data.google && data.google.enabled) setupGoogle(data.google.clientId);
  } catch {
    // Прослойка недоступна — форма всё равно работает, ошибку покажет отправка.
  }
  email.focus();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  hideError();
  submit.disabled = true;
  submit.textContent = 'Проверяем…';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email.value.trim(), password: password.value }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) throw new Error(data.error || 'Не удалось войти (' + res.status + ')');
    location.replace(next);
  } catch (err) {
    showError(err);
    password.value = '';
    password.focus();
  } finally {
    submit.disabled = false;
    submit.textContent = 'Войти';
  }
});

/* --- Google ---------------------------------------------------------------- */

function setupGoogle(clientId) {
  const script = document.createElement('script');
  script.src = 'https://accounts.google.com/gsi/client';
  script.async = true;
  script.defer = true;
  script.onload = () => {
    if (!window.google || !window.google.accounts) return;

    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: onGoogleCredential,
      cancel_on_tap_outside: true,
      auto_select: false,
    });
    window.google.accounts.id.renderButton(document.getElementById('google'), {
      type: 'standard',
      theme: document.documentElement.dataset.theme === 'dark' ? 'filled_black' : 'outline',
      size: 'large',
      text: 'signin_with',
      locale: 'ru',
      width: 320,
    });
    googleBlock.hidden = false;
  };
  script.onerror = () => hideError();
  document.head.append(script);
}

async function onGoogleCredential(response) {
  hideError();
  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential: response.credential }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) throw new Error(data.error || 'Google-вход не прошёл (' + res.status + ')');
    location.replace(next);
  } catch (err) {
    showError(err);
  }
}

/* --- Мелочи ---------------------------------------------------------------- */

/**
 * Куда вернуть человека после входа. Свой путь — как был. Полный адрес
 * принимается, только если это viferon.digital или его поддомен по https:
 * дашборды живут на поддоменах и уводят сюда с «?next=https://ba.viferon…».
 * Всё остальное — на главную: «?next=//чужой.сайт» никуда не уведёт.
 */
function safeNext(raw) {
  const value = String(raw || '/');
  if (value.startsWith('/') && !value.startsWith('//')) return value;

  try {
    const url = new URL(value);
    const base = location.hostname.split('.').slice(-2).join('.');
    const ours = url.hostname === base || url.hostname.endsWith('.' + base);
    if (url.protocol === 'https:' && ours) return url.toString();
  } catch {
    // не адрес — значит, на главную
  }
  return '/';
}

function showError(err) {
  error.textContent = String(err && err.message ? err.message : err);
  error.hidden = false;
}

function hideError() {
  error.hidden = true;
}
