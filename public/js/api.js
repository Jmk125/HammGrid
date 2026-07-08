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

async function requireSession() {
  try {
    const { user } = await api('GET', '/api/auth/me');
    return user;
  } catch (e) {
    window.location.href = '/login.html';
    return null;
  }
}
