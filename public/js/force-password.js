(function () {
  const form = document.getElementById('passwordUpdateForm');
  const error = document.getElementById('passwordError');
  const success = document.getElementById('passwordSuccess');
  const save = document.getElementById('savePassword');
  const showError = message => {
    error.textContent = message;
    error.hidden = false;
    success.hidden = true;
  };

  form.addEventListener('submit', async event => {
    event.preventDefault();
    error.hidden = true;
    success.hidden = true;
    const newPassword = document.getElementById('newPassword').value;
    if (newPassword !== document.getElementById('confirmPassword').value) return showError('As senhas novas não coincidem.');
    save.disabled = true;
    try {
      const response = await fetch('/api/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({
          currentPassword: document.getElementById('currentPassword').value,
          newPassword
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return showError(data.error || 'Não foi possível alterar a senha. Tente novamente.');
      success.textContent = 'Senha atualizada. Abrindo sua conta…';
      success.hidden = false;
      window.location.replace(data.role === 'admin' ? '/admin' : '/dashboard');
    } catch (e) {
      showError('Não foi possível conectar ao FileShare. Verifique sua conexão e tente novamente.');
    } finally {
      save.disabled = false;
    }
  });

  document.getElementById('passwordLogout').addEventListener('click', async () => {
    try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store' }); } catch (e) {}
    window.location.replace('/');
  });
})();
