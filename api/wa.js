// api/wa.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const admin = require('firebase-admin');
const qrcode = require('qrcode');

// Inisialisasi Firebase Admin SDK (gunakan service account dari Vercel environment)
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: 'whisper-ca26f'
    });
}
const db = admin.firestore();

// Fungsi untuk menyimpan QR ke Firestore
async function updateSession(sessionId, data) {
    await db.collection('sessions').doc(sessionId).set(data, { merge: true });
}

// Ekspor handler untuk Vercel
module.exports = async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET');

    // Jika request GET dengan parameter download -> kirim file hasil
    if (req.method === 'GET' && req.query.download) {
        const sessionId = req.query.download;
        const doc = await db.collection('sessions').doc(sessionId).get();
        if (!doc.exists) return res.status(404).send('Not found');
        const data = doc.data();
        if (!data.exportResult) return res.status(404).send('Belum ada hasil');
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename="chats.json"');
        return res.send(data.exportResult);
    }

    // Hanya terima POST untuk memulai sesi baru
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Buat sessionId unik
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2,6)}`;
    await updateSession(sessionId, { status: 'initializing' });

    // Jalankan client WhatsApp Web di background (tanpa menunggu)
    (async () => {
        try {
            const client = new Client({
                authStrategy: new LocalAuth({ clientId: sessionId }),
                puppeteer: {
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox']
                }
            });

            client.on('qr', async (qr) => {
                // Generate data URL QR
                const qrImage = await qrcode.toDataURL(qr);
                await updateSession(sessionId, { qr: qrImage, status: 'qr_ready' });
            });

            client.on('authenticated', async (session) => {
                await updateSession(sessionId, { 
                    loggedIn: true, 
                    session: session,
                    status: 'authenticated'
                });
            });

            client.on('ready', async () => {
                await updateSession(sessionId, { status: 'exporting' });
                // Ekspor semua chat
                try {
                    const chats = await client.getChats();
                    const allMessages = {};
                    for (let chat of chats.slice(0, 10)) { // batasi 10 chat
                        const msgs = await chat.fetchMessages({ limit: 1000 });
                        allMessages[chat.id._serialized] = msgs.map(m => ({
                            from: m.author || m.from,
                            body: m.body,
                            time: m.timestamp
                        }));
                    }
                    // Simpan hasil ke Firestore (maks 1MB, kompres jika perlu)
                    await updateSession(sessionId, {
                        exportDone: true,
                        exportResult: JSON.stringify(allMessages),
                        status: 'done'
                    });
                } catch (e) {
                    await updateSession(sessionId, { error: e.message, status: 'error' });
                }
                await client.destroy();
            });

            await client.initialize();
        } catch (e) {
            await updateSession(sessionId, { error: e.message, status: 'error' });
        }
    })();

    // Kirim sessionId balik ke frontend
    res.status(200).json({ sessionId });
};
