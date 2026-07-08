document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('error');
  errorEl.style.display = 'none';
  try {
    await api('POST', '/api/auth/login', {
      username: document.getElementById('username').value,
      password: document.getElementById('password').value,
    });
    window.location.href = '/dashboard.html';
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
  }
});
