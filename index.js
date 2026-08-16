const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const readline = require('readline');

// දුරකථන අංකය මෙහි ඇතුළත් කරන්න (උදා: 94712345678 - රටේ කේතය සමඟ, + ලකුණු නොමැතිව)
const phoneNumber = "94712345678"; 

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

async function startBot() {
    // Session දත්ත සුරක්ෂිතව තබා ගැනීම සඳහා
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }), // ලොග් මට්ටම අවම කර ඇත
        printQRInTerminal: false, // QR කේතය වෙනුවට Pairing Code භාවිතා කරයි
        auth: state,
    });

    // Pairing Code ලබා ගැනීමේ කොටස
    if (!sock.authState.creds.registered) {
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        
        setTimeout(async () => {
            try {
                console.log('🔄 Requesting Pairing Code...');
                let code = await sock.requestPairingCode(cleanNumber);
                code = code?.match(/.{1,4}/g)?.join('-') || code; // කේතය කියවීමට පහසු වන සේ සකස් කරයි
                
                console.log(`\n${'='.repeat(50)}`);
                console.log(`⚡ HDNOVA PAIRING CODE: ${code}`);
                console.log('='.repeat(50) + '\n');
            } catch (error) {
                console.error("❌ Pairing error:", error.message || error);
            }
        }, 8000); // සම්බන්ධ වීම සඳහා තත්පර 8ක ප්‍රමාදයක් ලබා දී ඇත
    }

    // සම්බන්ධතාවය යාවත්කාලීන කිරීම සහ හැසිරවීම
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('✅ Bot successfully connected to WhatsApp!');
        }
    });

    // අක්තපත්‍ර (Credentials) වෙනස් වන විට ස්වයංක්‍රීයව Save වීම
    sock.ev.on('creds.update', saveCreds);

    // ලැබෙන පණිවිඩ හැසිරවීම (Message Handler)
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const messageType = Object.keys(msg.message)[0];
        console.log('New message received:', messageType);
        
        // ඔබට මෙහි Bot එකේ විධාන (commands) ලියාගත හැක.
    });
}

startBot();
