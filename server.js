const fastify = require('fastify')({ 
    logger: true,
    trustProxy: true 
});
const mysql = require('mysql2/promise');
const cors = require('@fastify/cors');
const multer = require('fastify-multer'); 
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
require('dotenv').config();

// 1. Register CORS
fastify.register(cors, { origin: true });

// 2. THE ULTIMATE FIX: Catch-all Content Type Parser
fastify.addContentTypeParser('*', (req, payload, done) => {
  done();
});

// 3. Register Multer Content Parser
fastify.register(multer.contentParser);

// Note: Static serving of /uploads will no longer work for NEW photos 
// because they are now stored in the database.
fastify.register(require('@fastify/static'), {
    root: path.join(__dirname, 'uploads'),
    prefix: '/uploads/', 
});

// --- DATABASE CONNECTION WITH SSL FOR AIVEN ---
const db = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 20401,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: {
        rejectUnauthorized: false, 
        minVersion: 'TLSv1.2'
    },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 60000,
    acquireTimeout: 60000
});

// --- HOME ROUTE ---
fastify.get('/', async (request, reply) => {
    return { 
        success: true, 
        message: "GK App Backend is Running Successfully!",
        timestamp: new Date().toISOString() 
    };
});

const generateTripId = (name) => {
    const date = new Date().toISOString().slice(0,10).replace(/-/g,"");
    return `GE-${name.substring(0,3).toUpperCase()}-${date}-${Math.floor(1000 + Math.random() * 9000)}`;
};

// --- UPDATED: USE MEMORY STORAGE TO FIX EROFS ERROR ---
const storage = multer.memoryStorage();

// --- MULTER LIMITS ---
const upload = multer({ 
    storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10 MB limit
    }
});

// --- ROUTES ---

fastify.post('/api/login', async (request, reply) => {
    const { username, password } = request.body;
    const [rows] = await db.execute('SELECT id, username, role, full_name FROM users WHERE username = ? AND password = ?', [username, password]);
    if (rows.length > 0) return { success: true, user: rows[0] };
    reply.status(401).send({ message: "Invalid Credentials" });
});

fastify.get('/api/check-active-trip/:empId', async (request, reply) => {
    const { empId } = request.params;
    const [rows] = await db.execute(
        'SELECT trip_id FROM trips WHERE employee_id = ? AND status = "started" LIMIT 1', 
        [empId]
    );
    if (rows.length > 0) return { active: true, tripId: rows[0].trip_id };
    return { active: false };
});

fastify.post('/api/start-trip', { preHandler: upload.single('photo') }, async (request, reply) => {
    const { empId, empName, vehicleNo, loading, unloading, material, partyName, locName, loading_date, captureTime } = request.body;
    
    // Convert buffer to Base64 string for database storage
    const photoData = request.file ? `data:${request.file.mimetype};base64,${request.file.buffer.toString('base64')}` : null;
    
    const tripId = generateTripId(empName);
    const finalTime = new Date(captureTime || new Date()).toISOString().slice(0, 19).replace('T', ' ');
    const finalLoadingDate = loading_date ? loading_date.split('T')[0] : new Date().toISOString().split('T')[0];

    await db.execute(
        `INSERT INTO trips (trip_id, employee_id, vehicle_no, loading_point, unloading_point, material, party_name, loading_photo, location_name, capture_time, status, loading_date) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', ?)`,
        [tripId, empId, vehicleNo, loading, unloading, material, partyName, photoData, locName, finalTime, finalLoadingDate]
    );
    return { success: true, tripId };
});

fastify.post('/api/complete-trip', { preHandler: upload.single('photo') }, async (request, reply) => {
    const { 
        tripId, travelKm, diesel, bhatta, toll, rto, other_exp, 
        party_number, 
        unloading_date 
    } = request.body;
    
    const calculatedDriverBalance = 
        Number(diesel || 0) + 
        Number(bhatta || 0) + 
        Number(toll || 0) + 
        Number(rto || 0) + 
        Number(other_exp || 0);
    
    // Convert buffer to Base64 string for database storage
    const photoData = request.file ? `data:${request.file.mimetype};base64,${request.file.buffer.toString('base64')}` : null;
    
    const finalUnloadingDate = unloading_date ? unloading_date.split('T')[0] : new Date().toISOString().split('T')[0];
    
    await db.execute(
        `UPDATE trips SET 
            unloading_photo = ?, 
            travel_km = ?, 
            diesel_amt = ?, 
            bhatta = ?, 
            toll_amt = ?, 
            rto_police_expenses = ?, 
            other_expenses = ?, 
            party_number = ?, 
            driver_balance = ?, 
            unloading_date = ?, 
            status = 'completed' 
         WHERE trip_id = ?`,
        [
            photoData, 
            travelKm, 
            Number(diesel || 0), 
            Number(bhatta || 0), 
            Number(toll || 0), 
            Number(rto || 0), 
            Number(other_exp || 0), 
            party_number || null, 
            calculatedDriverBalance,
            finalUnloadingDate, 
            tripId
        ]
    );
    return { success: true };
});

// --- PARTY DETAILS & FEEDBACK ROUTE ---
fastify.post('/api/admin/party-details', async (request, reply) => {
    const { name, mobile, totalAmount, advance, feedback } = request.body;
    
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        await connection.execute(
            `INSERT INTO party_details (party_name, mobile_no, total_amount, advance_paid) 
             VALUES (?, ?, ?, ?) 
             ON DUPLICATE KEY UPDATE 
             party_name = VALUES(party_name),
             total_amount = VALUES(total_amount),
             advance_paid = VALUES(advance_paid)`,
            [name, mobile, Number(totalAmount || 0), Number(advance || 0)]
        );

        const [partyRow] = await connection.execute('SELECT id FROM party_details WHERE mobile_no = ?', [mobile]);
        const partyId = partyRow[0].id;

        if (feedback && feedback.trim() !== "") {
            await connection.execute(
                'INSERT INTO party_call_logs (party_id, feedback_text) VALUES (?, ?)',
                [partyId, feedback]
            );
        }

        await connection.commit();
        return { success: true };
    } catch (err) {
        await connection.rollback();
        fastify.log.error(err);
        reply.status(500).send({ success: false, message: "Database Error", error: err.message });
    } finally {
        connection.release();
    }
});

// --- GET PARTY BY MOBILE & FEEDBACK HISTORY ---
fastify.get('/api/admin/party/:mobile', async (request, reply) => {
    const { mobile } = request.params;
    try {
        const [party] = await db.execute('SELECT * FROM party_details WHERE mobile_no = ?', [mobile]);
        
        if (party.length > 0) {
            const [history] = await db.execute(
                'SELECT feedback_text, call_date FROM party_call_logs WHERE party_id = ? ORDER BY call_date DESC', 
                [party[0].id]
            );
            return { exists: true, party: party[0], history };
        }
        return { exists: false };
    } catch (err) {
        reply.status(500).send({ message: "Error fetching party info" });
    }
});

// --- GET ALL PARTIES ---
fastify.get('/api/admin/parties-all', async (request, reply) => {
    try {
        const [rows] = await db.execute(`
            SELECT *, 
            (total_amount - advance_paid) as balance,
            CASE 
                WHEN (total_amount - advance_paid) <= 0 THEN 'Paid'
                ELSE 'Pending'
            END as payment_status
            FROM party_details 
            ORDER BY payment_status DESC, party_name ASC
        `);
        return rows;
    } catch (err) {
        reply.status(500).send({ message: "Error fetching directory" });
    }
});

// --- REMINDER ROUTE ---
fastify.get('/api/admin/reminders', async (request, reply) => {
  try {
    const [rows] = await db.execute(`
      SELECT id, party_name, mobile_no, total_amount, advance_paid 
      FROM party_details 
      WHERE (total_amount - advance_paid) > 0 
      ORDER BY (total_amount - advance_paid) DESC
    `);
    return rows;
  } catch (err) {
    reply.status(500).send({ message: "Error fetching reminders" });
  }
});

// --- EDIT PARTY DETAILS ---
fastify.put('/api/admin/edit-party/:id', async (request, reply) => {
    const { id } = request.params;
    const { name, mobile, totalAmount, advance } = request.body;
    try {
        await db.execute(
            `UPDATE party_details SET party_name = ?, mobile_no = ?, total_amount = ?, advance_paid = ? WHERE id = ?`,
            [name, mobile, Number(totalAmount || 0), Number(advance || 0), id]
        );
        return { success: true };
    } catch (err) {
        reply.status(500).send({ message: "Error updating party details" });
    }
});

fastify.get('/api/admin/trips', async () => {
    const [rows] = await db.execute(`
        SELECT t.*, u.full_name 
        FROM trips t 
        JOIN users u ON t.employee_id = u.id 
        ORDER BY FIELD(t.status, 'started', 'completed') ASC, t.id DESC
    `);
    return rows;
});

fastify.delete('/api/admin/delete-trip/:id', async (request, reply) => {
    const { id } = request.params;
    await db.execute('DELETE FROM trips WHERE id = ?', [id]);
    return { success: true };
});

// --- DELETE PARTY ROUTE ---
fastify.delete('/api/admin/delete-party/:id', async (request, reply) => {
    const { id } = request.params;
    try {
        await db.execute('DELETE FROM party_call_logs WHERE party_id = ?', [id]);
        await db.execute('DELETE FROM party_details WHERE id = ?', [id]);
        return { success: true };
    } catch (err) {
        reply.status(500).send({ message: "Error deleting party" });
    }
});

// --- VERCEL ADAPTER ---
const handler = async (req, res) => {
    await fastify.ready();
    fastify.server.emit('request', req, res);
};

const start = async () => {
    try {
        await fastify.listen({ port: process.env.PORT || 5000, host: '0.0.0.0' });
        console.log(`✅ Backend is LIVE on port ${process.env.PORT || 5000}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

if (process.env.NODE_ENV !== 'production') {
    start();
}

module.exports = handler;

// Final Build Deployment Trigger - Ver 1.0.1