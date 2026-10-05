function getUserById(db, userId) {
  const query = `SELECT * FROM users WHERE id = ${userId}`;
  return db.query(query);
}

module.exports = { getUserById };
