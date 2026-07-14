async function api(method, url, body) {
  const opts = {
    method,
    credentials: 'same-origin',
    headers: {},
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    // no body
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const CACHED_SESSION_KEY = 'hammgrid:last-user';

function getCachedSessionUser() {
  try {
    const raw = localStorage.getItem(CACHED_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function setCachedSessionUser(user) {
  try {
    if (user) localStorage.setItem(CACHED_SESSION_KEY, JSON.stringify(user));
    else localStorage.removeItem(CACHED_SESSION_KEY);
  } catch (e) {
    // localStorage can be blocked/private-mode constrained; online auth still works.
  }
}

async function requireSession() {
  try {
    const { user } = await api('GET', '/api/auth/me');
    setCachedSessionUser(user);
    return user;
  } catch (e) {
    const cachedUser = getCachedSessionUser();
    if (!e.status && cachedUser) return cachedUser;
    window.location.href = '/login.html';
    return null;
  }
}
