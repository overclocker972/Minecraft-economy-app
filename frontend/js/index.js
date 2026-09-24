// Page d'accueil : connexion / inscription.

if (localStorage.getItem('mceco_token')) {
  location.replace('/dashboard.html');
}

document.getElementById('tab-login').addEventListener('click', () => switchTab('login'));
document.getElementById('tab-register').addEventListener('click', () => switchTab('register'));

function switchTab(which) {
  const isLogin = which === 'login';
  document.getElementById('tab-login').classList.toggle('active', isLogin);
  document.getElementById('tab-register').classList.toggle('active', !isLogin);
  document.getElementById('form-login').hidden = !isLogin;
  document.getElementById('form-register').hidden = isLogin;
}

document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('login-msg');
  try {
    const data = await api('/auth/login', {
      method: 'POST',
      body: {
        username: document.getElementById('login-username').value,
        password: document.getElementById('login-password').value,
      },
    });
    setToken(data.token);
    localStorage.setItem('mceco_user', JSON.stringify(data.user));
    location.href = '/dashboard.html';
  } catch (err) {
    flash(msg, err.message);
  }
});

document.getElementById('form-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('register-msg');
  try {
    const data = await api('/auth/register', {
      method: 'POST',
      body: {
        username: document.getElementById('reg-username').value,
        mc_pseudo: document.getElementById('reg-mc').value,
        password: document.getElementById('reg-password').value,
      },
    });
    setToken(data.token);
    localStorage.setItem('mceco_user', JSON.stringify(data.user));
    location.href = '/dashboard.html';
  } catch (err) {
    flash(msg, err.message);
  }
});
