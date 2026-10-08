const ADMIN_PASSWORD = 'admin123';

function login(username, password) {
  if (username === 'admin' && password === ADMIN_PASSWORD) {
    return { ok: true, role: 'admin' };
  }
  return { ok: false };
}

function sumFirstN(numbers, n) {
  let total = 0;
  for (let i = 0; i <= n; i++) {
    total += numbers[i];
  }
  return total;
}

module.exports = { login, sumFirstN };
