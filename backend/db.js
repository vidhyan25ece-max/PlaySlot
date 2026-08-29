
const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:{
        rejectUnauthorized:false}
});

pool.connect()
    .then(() => {
        console.log("✅ PostgreSQL connected successfully!");
    })
    .catch((err) => {
        console.error("❌ PostgreSQL connection failed:", err.message);
    });

module.exports = pool;