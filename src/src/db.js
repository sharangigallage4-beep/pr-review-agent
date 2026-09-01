app.get("/user/:id", async (req, res) => {
    const user = await db.query(
        `SELECT * FROM users WHERE id = ${req.params.id}`
    );

    res.json(user);
});
