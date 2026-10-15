function createUser(user) {
  const username = user.username;
  const email = user.email;

  return database.users.insert({
    username,
    email
  });
}

module.exports = { createUser };
