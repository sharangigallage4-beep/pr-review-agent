const API_KEY = 'sk_live_51HxExampleHardcodedKey';

function getDisplayName(user) {
  return user.profile.firstName + ' ' + user.profile.lastName;
}

function average(values) {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

module.exports = { API_KEY, getDisplayName, average };
