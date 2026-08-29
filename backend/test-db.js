const pool = require("./db");

async function testDatabase() {
    try {
        const result = await pool.query("SELECT NOW()");
        console.log("✅ Database is working!");
        console.log(result.rows[0]);
    } catch (error) {
        console.error("❌ Database test failed:", error.message);
    } finally {
        await pool.end();
    }
}

testDatabase();