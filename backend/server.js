const express = require("express");
const cors = require("cors");
const pool = require("./db");

const app = express();
const PORT = 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Home route
app.get("/", (req, res) => {
    res.json({
        message: "PlaySlot backend is running!"
    });
});

// Get all facilities
app.get("/api/facilities", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM facilities ORDER BY facility_id"
        );

        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({
            error: "Failed to fetch facilities"
        });
    }
});
// Get slots for a facility
app.get("/api/facilities/:id/slots", async (req, res) => {
    try {
        const facilityId = req.params.id;

        const result = await pool.query(
            `SELECT 
                slot_id,
                facility_id,
                slot_date,
                start_time,
                end_time
             FROM slots
             WHERE facility_id = $1
             ORDER BY slot_date, start_time`,
            [facilityId]
        );

        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({
            error: "Failed to fetch slots"
        });
    }
});
// Create a booking
app.post("/api/bookings", async (req, res) => {
    const { user_id, facility_id, slot_id } = req.body;

    if (!user_id || !facility_id || !slot_id) {
        return res.status(400).json({
            error: "user_id, facility_id and slot_id are required"
        });
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // Check that the slot belongs to the selected facility
        const slotResult = await client.query(
            `SELECT * FROM slots
             WHERE slot_id = $1 AND facility_id = $2`,
            [slot_id, facility_id]
        );

        if (slotResult.rows.length === 0) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                error: "Slot not found for this facility"
            });
        }

        // Try to book the slot
        const bookingResult = await client.query(
            `INSERT INTO bookings
                (user_id, facility_id, slot_id, status)
             VALUES ($1, $2, $3, 'CONFIRMED')
             RETURNING *`,
            [user_id, facility_id, slot_id]
        );

        await client.query("COMMIT");

        res.status(201).json({
            message: "Booking confirmed!",
            booking: bookingResult.rows[0]
        });

    } catch (error) {
        await client.query("ROLLBACK");

        // PostgreSQL unique violation
        if (error.code === "23505") {
            return res.status(409).json({
                message: "Sorry, this slot has already been booked."
            });
        }

        console.error(error);

        res.status(500).json({
            error: "Booking failed"
        });

    } finally {
        client.release();
    }
});
// Get all bookings
app.get("/api/bookings", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                b.booking_id,
                b.user_id,
                u.name AS user_name,
                f.name AS facility_name,
                s.slot_date,
                s.start_time,
                s.end_time,
                b.status,
                b.created_at
            FROM bookings b
            JOIN users u ON b.user_id = u.user_id
            JOIN facilities f ON b.facility_id = f.facility_id
            JOIN slots s ON b.slot_id = s.slot_id
            ORDER BY b.created_at DESC
        `);

        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({
            error: "Failed to fetch bookings"
        });
    }
});
// Cancel booking + promote waitlist
app.delete("/api/bookings/:id", async (req, res) => {
    const bookingId = req.params.id;
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // 1. Find the active booking
        const bookingResult = await client.query(
            `SELECT *
             FROM bookings
             WHERE booking_id = $1
             AND status = 'CONFIRMED'
             FOR UPDATE`,
            [bookingId]
        );

        if (bookingResult.rows.length === 0) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                error: "Active booking not found"
            });
        }

        const booking = bookingResult.rows[0];

        // 2. Cancel the booking
        await client.query(
            `UPDATE bookings
             SET status = 'CANCELLED'
             WHERE booking_id = $1`,
            [bookingId]
        );

        // 3. Find first person in waitlist
        const waitlistResult = await client.query(
            `SELECT *
             FROM waitlist
             WHERE facility_id = $1
             AND slot_id = $2
             ORDER BY position ASC
             LIMIT 1
             FOR UPDATE`,
            [booking.facility_id, booking.slot_id]
        );

        let promotedUser = null;

        // 4. Promote first waitlisted user
        if (waitlistResult.rows.length > 0) {
            const waitlisted = waitlistResult.rows[0];

            const newBooking = await client.query(
                `INSERT INTO bookings
                    (user_id, facility_id, slot_id, status)
                 VALUES ($1, $2, $3, 'CONFIRMED')
                 RETURNING *`,
                [
                    waitlisted.user_id,
                    waitlisted.facility_id,
                    waitlisted.slot_id
                ]
            );

            promotedUser = newBooking.rows[0];

            // Remove from waitlist
            await client.query(
                `DELETE FROM waitlist
                 WHERE waitlist_id = $1`,
                [waitlisted.waitlist_id]
            );
        }

        await client.query("COMMIT");

        res.json({
            message: "Booking cancelled successfully!",
            cancelled_booking: booking,
            promoted_booking: promotedUser
        });

    } catch (error) {
        await client.query("ROLLBACK");

        console.error(error);

        res.status(500).json({
            error: "Failed to cancel booking"
        });

    } finally {
        client.release();
    }
});
// Join waitlist
app.post("/api/waitlist", async (req, res) => {
    const { user_id, facility_id, slot_id } = req.body;

    if (!user_id || !facility_id || !slot_id) {
        return res.status(400).json({
            error: "user_id, facility_id and slot_id are required"
        });
    }

    try {
        // Check if slot exists
        const slotResult = await pool.query(
            `SELECT * FROM slots
             WHERE slot_id = $1 AND facility_id = $2`,
            [slot_id, facility_id]
        );

        if (slotResult.rows.length === 0) {
            return res.status(404).json({
                error: "Slot not found"
            });
        }

        // Check if user is already on waitlist
        const existing = await pool.query(
            `SELECT * FROM waitlist
             WHERE user_id = $1
             AND facility_id = $2
             AND slot_id = $3`,
            [user_id, facility_id, slot_id]
        );

        if (existing.rows.length > 0) {
            return res.status(409).json({
                error: "You are already on the waitlist"
            });
        }

        // Get next position
        const positionResult = await pool.query(
            `SELECT COALESCE(MAX(position), 0) + 1 AS next_position
             FROM waitlist
             WHERE facility_id = $1
             AND slot_id = $2`,
            [facility_id, slot_id]
        );

        const position = positionResult.rows[0].next_position;

        // Add user to waitlist
        const result = await pool.query(
            `INSERT INTO waitlist
                (user_id, facility_id, slot_id, position)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [user_id, facility_id, slot_id, position]
        );

        res.status(201).json({
            message: "Added to waitlist!",
            waitlist: result.rows[0]
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to join waitlist"
        });
    }
});
// Get waitlist
app.get("/api/waitlist", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                w.waitlist_id,
                w.user_id,
                u.name AS user_name,
                w.facility_id,
                f.name AS facility_name,
                w.slot_id,
                s.slot_date,
                s.start_time,
                s.end_time,
                w.position,
                w.created_at
            FROM waitlist w
            JOIN users u
                ON w.user_id = u.user_id
            JOIN facilities f
                ON w.facility_id = f.facility_id
            JOIN slots s
                ON w.slot_id = s.slot_id
            ORDER BY w.position ASC
        `);

        res.json(result.rows);

    } catch (error) {
        console.error("Waitlist error:", error);

        res.status(500).json({
            error: "Failed to fetch waitlist"
        });
    }
});
// Get currently booked slot IDs
app.get("/api/bookings/slot-ids", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT slot_id
            FROM bookings
            WHERE status = 'CONFIRMED'
        `);

        res.json(result.rows.map(row => row.slot_id));

    } catch (error) {
        console.error("Slot status error:", error);

        res.status(500).json({
            error: "Failed to fetch booked slots"
        });
    }
});
// Join waitlist
app.post("/api/waitlist", async (req, res) => {
    try {
        const { user_id, facility_id, slot_id } = req.body;

        // Check if slot is already booked
        const bookingCheck = await pool.query(
            `SELECT booking_id
             FROM bookings
             WHERE slot_id = $1
             AND status = 'CONFIRMED'`,
            [slot_id]
        );

        if (bookingCheck.rows.length === 0) {
            return res.status(400).json({
                error: "This slot is available. You can book it directly."
            });
        }

        // Check if user is already on the waitlist
        const existingWaitlist = await pool.query(
            `SELECT waitlist_id
             FROM waitlist
             WHERE user_id = $1
             AND slot_id = $2`,
            [user_id, slot_id]
        );

        if (existingWaitlist.rows.length > 0) {
            return res.status(400).json({
                error: "You are already on the waitlist."
            });
        }

        // Find next position
        const positionResult = await pool.query(
            `SELECT COALESCE(MAX(position), 0) + 1 AS next_position
             FROM waitlist
             WHERE slot_id = $1`,
            [slot_id]
        );

        const position = positionResult.rows[0].next_position;

        // Add user to waitlist
        const result = await pool.query(
            `INSERT INTO waitlist
                (user_id, facility_id, slot_id, position)
             VALUES
                ($1, $2, $3, $4)
             RETURNING *`,
            [user_id, facility_id, slot_id, position]
        );

        res.status(201).json({
            message: "Joined waitlist successfully!",
            waitlist: result.rows[0]
        });

    } catch (error) {
        console.error("Waitlist error:", error);

        res.status(500).json({
            error: "Failed to join waitlist"
        });
    }
});
app.post("/api/login", async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({
            error: "Email and password are required"
        });
    }

    try {
        const result = await pool.query(
            `SELECT user_id, name, email
             FROM users
             WHERE email = $1 AND password = $2`,
            [email, password]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                error: "Invalid email or password"
            });
        }

        const user = result.rows[0];

        res.json({
            message: "Login successful",
            user: user
        });

    } catch (error) {
        console.error("Login error:", error);

        res.status(500).json({
            error: "Login failed"
        });
    }
});
// Start server
app.listen(PORT, () => {
    console.log(`🚀 PlaySlot server running on http://localhost:${PORT}`);
});