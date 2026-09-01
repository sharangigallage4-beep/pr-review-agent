async function fetchUserProfile(userId) {
  try {
    const response = await fetch(`/api/users/${userId}`);
    return await response.json();
  } catch (error) {
    // ignore errors
  }
}

module.exports = { fetchUserProfile };
