require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
    fetchLatestBaileysVersion,
    jidNormalizedUser
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');

// ================================================================
// Express Server
// ================================================================
const app = express();
const PORT = process.env.PORT || 7860;

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>HDNOVA Bot</title></head>
            <body style="background:#000;color:#0f0;font-family:monospace;text-align:center;padding:50px;">
                <h1>⚡ HDNOVA WHATSAPP BOT ⚡</h1>
                <p>✅ Bot is Running Successfully</p>
                <p>🔗 Railway Deployment Active</p>
                <p>📅 ${new Date().toLocaleString()}</p>
            </body>
        </html>
    `);
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// ================================================================
// MongoDB Connection
// ================================================================
const mongoURI = process.env.MONGO_URI;
if (!mongoURI) {
    console.error('❌ MONGO_URI not found in environment variables!');
    process.exit(1);
}

mongoose.set('strictQuery', true);

async function connectMongo() {
    try {
        await mongoose.connect(mongoURI);
        console.log('✅ Connected to MongoDB Atlas');
    } catch (err) {
        console.error('❌ MongoDB connection error, retrying in 5s:', err.message);
        setTimeout(connectMongo, 5000);
    }
}
connectMongo();

mongoose.connection.on('disconnected', () => {
    console.log('⚠️ MongoDB disconnected, attempting reconnect...');
    setTimeout(connectMongo, 5000);
});

// ================================================================
// Database Schemas
// ================================================================
const settingsSchema = new mongoose.Schema({
    jid: { type: String, unique: true, required: true },
    settings: { type: Object, default: {} }
});

const userSchema = new mongoose.Schema({
    jid: { type: String, unique: true, required: true },
    name: String,
    messageCount: { type: Number, default: 0 },
    aiCount: { type: Number, default: 0 },
    joinedAt: { type: Date, default: Date.now }
});

const groupSchema = new mongoose.Schema({
    jid: { type: String, unique: true, required: true },
    name: String,
    settings: {
        welcome: { type: Boolean, default: false },
        antilink: { type: Boolean, default: false },
        antispam: { type: Boolean, default: false }
    }
});

const Settings = mongoose.model('Settings', settingsSchema);
const User = mongoose.model('User', userSchema);
const Group = mongoose.model('Group', groupSchema);

// ================================================================
// Global Settings
// ================================================================
let botSettings = {
    autoStatusSeen: true,
    autoStatusDownload: true,
    autoRead: false,
    antiDelete: true,
    callShield: true,
    ownerNotifications: true
};

async function loadSettings() {
    try {
        const doc = await Settings.findOne({ jid: 'global' });
        if (doc) botSettings = { ...botSettings, ...doc.settings };
    } catch (e) {
        console.log('Creating default settings...');
    }
}

async function saveSettings() {
    try {
        await Settings.findOneAndUpdate(
            { jid: 'global' },
            { settings: botSettings },
            { upsert: true }
        );
    } catch (e) {
        console.error('Error saving settings:', e);
    }
}

// ================================================================
// Message Store for Anti-Delete
// ================================================================
const messageStore = new Map();
const MESSAGE_STORE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

setInterval(() => {
    const now = Date.now();
    let removed = 0;
    for (const [id, entry] of messageStore.entries()) {
        if (now - entry.timestamp > MESSAGE_STORE_TTL_MS) {
            messageStore.delete(id);
            removed++;
        }
    }
    if (removed > 0) console.log(`🧹 Cleared ${removed} expired message-store entries`);
}, 60 * 60 * 1000);

// ================================================================
// Statistics
// ================================================================
let stats = {
    totalMessages: 0,
    aiRequests: 0,
    downloads: 0,
    stickers: 0,
    statusProcessed: 0
};

function getDateTime() {
    const now = new Date();
    return {
        date: now.toLocaleDateString('en-GB'),
        time: now.toLocaleTimeString('en-GB', { hour12: false }),
        timestamp: now.getTime()
    };
}

// ================================================================
// Main WhatsApp Connection Function
// ================================================================
async function connectToWhatsApp() {
    await loadSettings();

    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        version,
        browser: ['HDNOVA-OFC', 'Chrome', '121.0.0']
    });

    const phoneNumber = process.env.PHONE_NUMBER;
    const ownerJid = jidNormalizedUser(`${phoneNumber}@s.whatsapp.net`);

    function checkIsOwner(m, from) {
        if (m.key.fromMe) return true;
        try {
            const selfJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
            const senderJid = m.key.participant
                ? jidNormalizedUser(m.key.participant)
                : jidNormalizedUser(from);
            return senderJid === ownerJid || (selfJid && senderJid === selfJid);
        } catch (e) {
            return m.key.participant === ownerJid || from === ownerJid;
        }
    }

    // Pairing Code
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber);
                console.log(`\n${'='.repeat(50)}`);
                console.log(`⚡ HDNOVA PAIRING CODE: ${code}`);
                console.log('='.repeat(50) + '\n');
            } catch (error) {
                console.error("Pairing error:", error);
            }
        }, 8000);
    }

    // Connection Updates
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 5000);
            }
        } else if (connection === 'open') {
            console.log('✅ HDNOVA Bot Connected Successfully!');
            if (botSettings.ownerNotifications) {
                await sock.sendMessage(ownerJid, {
                    text: `🟢 *HDNOVA BOT ONLINE*\n\n📅 ${getDateTime().date}\n⏰ ${getDateTime().time}\n\n✅ All systems operational`
                });
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Messages Upsert Handler
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message) return;

        const from = m.key.remoteJid;

        // Auto Read
        if (botSettings.autoRead && from) {
            try {
                await sock.readMessages([m.key]);
            } catch (e) {}
        }

        const body = m.message.conversation ||
                     m.message.extendedTextMessage?.text ||
                     m.message.imageMessage?.caption ||
                     m.message.videoMessage?.caption || "";

        const isOwner = checkIsOwner(m, from);
        const isGroup = from.endsWith('@g.us');
        const sender = m.key.participant || m.key.remoteJid;
        const pushName = m.pushName || "Unknown";

        // 🔒 Private Bot Check (Owner Only)
        if (!isOwner) return;

        stats.totalMessages++;

        // Store message for anti-delete
        if (botSettings.antiDelete && m.key && m.key.id && from !== 'status@broadcast') {
            messageStore.set(m.key.id, {
                message: m.message,
                sender: sender,
                pushName: pushName,
                remoteJid: from,
                timestamp: Date.now()
            });
        }

        // Auto Status Handler
        if (from === 'status@broadcast') {
            stats.statusProcessed++;

            if (botSettings.autoStatusSeen) {
                try {
                    await sock.readMessages([m.key]);
                    const participant = m.key.participant || m.participant;
                    if (participant) {
                        await sock.sendMessage('status@broadcast', {
                            react: { text: '💚', key: m.key }
                        }, { statusJidList: [participant] });
                    }
                } catch (e) {}
            }

            if (botSettings.autoStatusDownload) {
                try {
                    const participant = m.key.participant || m.participant;
                    if (participant) {
                        let caption = `📥 *STATUS FROM:* @${participant.split('@')[0]}\n\n`;

                        if (m.message.imageMessage) {
                            const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
                            await sock.sendMessage(ownerJid, {
                                image: buffer,
                                caption: caption + (m.message.imageMessage.caption || ''),
                                mentions: [participant]
                            });
                        } else if (m.message.videoMessage) {
                            const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
                            await sock.sendMessage(ownerJid, {
                                video: buffer,
                                caption: caption + (m.message.videoMessage.caption || ''),
                                mentions: [participant]
                            });
                        }
                    }
                } catch (e) {
                    console.log('Status download error:', e);
                }
            }
            return;
        }

        // Update user data
        try {
            await User.findOneAndUpdate(
                { jid: sender },
                {
                    $inc: { messageCount: 1 },
                    $set: { name: pushName }
                },
                { upsert: true }
            );
        } catch (e) {}

        // React helper
        const react = async (emoji) => {
            try {
                await sock.sendMessage(from, { react: { text: emoji, key: m.key } });
            } catch (e) {}
        };

        // Command prefix
        const prefix = '.';
        if (!body.startsWith(prefix)) return;

        const args = body.slice(prefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        // Menu Command
        if (command === 'menu' || command === 'help') {
            await react('📜');
            const { date, time } = getDateTime();

            const menuText = `
╭━━━⊱ *HDNOVA-OFC* ⊱━━━╮
│ 
│ 👤 *User:* ${pushName}
│ 📅 *Date:* ${date}
│ ⏰ *Time:* ${time}
│ 🤖 *Bot:* ${process.env.BOT_NAME || 'HDNOVA'}
│ 
╰━━━━━━━━━━━━━━━━━╯

╭━━━ *MAIN MENU* ━━━╮
│
│ 🤖 *AI COMMANDS*
│ ├ .ai [query]
│ └ .gpt [query]
│
│ 🎨 *MEDIA TOOLS*
│ └ .sticker / .s
│
│ 🔍 *SEARCH*
│ ├ .wiki [term]
│ └ .weather [city]
│
│ 🛠️ *TOOLS*
│ └ .ping
│
${isOwner ? `│ 👑 *OWNER*
│ ├ .settings
│ ├ .stats
│ └ .restart
│` : ''}
╰━━━━━━━━━━━━━━━━━╯

> *HDNOVA-OFC* - Advanced WhatsApp Bot
`.trim();

            try {
                await sock.sendMessage(from, {
                    image: { url: 'https://i.ibb.co/Fb4QgTdR/image.jpg' },
                    caption: menuText
                }, { quoted: m });
            } catch (e) {
                await sock.sendMessage(from, { text: menuText }, { quoted: m });
            }
            return;
        }

        // Ping Command
        if (command === 'ping') {
            await react('⚡');
            const start = Date.now();
            const sentMsg = await sock.sendMessage(from, { text: '_Pinging..._ 🏓' }, { quoted: m });
            const latency = Date.now() - start;
            await sock.sendMessage(from, {
                text: `> ⚡ *HDNOVA PONG!*\n> Speed: *${latency}ms*`,
                edit: sentMsg.key
            });
            return;
        }

        // AI Command
        if (command === 'ai' || command === 'gpt' || command === 'chatgpt') {
            const query = args.join(' ');
            if (!query) {
                await sock.sendMessage(from, {
                    text: '❌ *Please provide a question!*\n\nExample: `.ai What is AI?`'
                }, { quoted: m });
                return;
            }

            await react('🤖');
            stats.aiRequests++;

            try {
                await User.findOneAndUpdate(
                    { jid: sender },
                    { $inc: { aiCount: 1 } },
                    { upsert: true }
                );

                const res = await axios.get(`https://apis.davidcyriltech.my.id/ai/gemini?query=${encodeURIComponent(query)}`);
                const answer = res.data.result || "Sorry, I couldn't process that.";

                await sock.sendMessage(from, {
                    text: `🤖 *HDNOVA AI*\n\n${answer}\n\n> _Powered by Gemini AI_`
                }, { quoted: m });
            } catch (e) {
                await sock.sendMessage(from, {
                    text: '❌ *AI Service Error!* Please try again later.'
                }, { quoted: m });
            }
            return;
        }

        // Wiki Command
        if (command === 'wiki' || command === 'search') {
            const query = args.join(' ');
            if (!query) {
                await sock.sendMessage(from, {
                    text: '❌ *Provide a search term!*\n\nExample: `.wiki Python`'
                }, { quoted: m });
                return;
            }

            await react('🔍');

            try {
                const wikiRes = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`, {
                    headers: { 'User-Agent': 'HDNOVABot/2.0' }
                });

                if (wikiRes.data && wikiRes.data.extract) {
                    const wikiText = `
🔍 *WIKIPEDIA RESULT* 📖

📌 *Title:* ${wikiRes.data.title}

📝 *Summary:*
${wikiRes.data.extract}

🔗 *Read more:* ${wikiRes.data.content_urls.desktop.page}

> *Powered by HDNOVA*
`.trim();
                    await sock.sendMessage(from, { text: wikiText }, { quoted: m });
                } else {
                    await sock.sendMessage(from, { text: '❌ *No results found!*' }, { quoted: m });
                }
            } catch (e) {
                await sock.sendMessage(from, { text: '❌ *Error searching Wikipedia!*' }, { quoted: m });
            }
            return;
        }

        // Weather Command
        if (command === 'weather') {
            const city = args.join(' ');
            if (!city) {
                await sock.sendMessage(from, {
                    text: '❌ *Provide a city name!*\n\nExample: `.weather Colombo`'
                }, { quoted: m });
                return;
            }

            await react('🌤️');

            try {
                const weatherRes = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
                const current = weatherRes.data.current_condition[0];
                const area = weatherRes.data.nearest_area[0];

                const weatherText = `
🌤️ *WEATHER REPORT* 🌡️

📍 *Location:* ${area.areaName[0].value}, ${area.country[0].value}
🌡️ *Temperature:* ${current.temp_C}°C / ${current.temp_F}°F
☁️ *Condition:* ${current.weatherDesc[0].value}
💧 *Humidity:* ${current.humidity}%
💨 *Wind:* ${current.windspeedKmph} km/h
👁️ *Visibility:* ${current.visibility} km

> *Powered by HDNOVA*
`.trim();
                await sock.sendMessage(from, { text: weatherText }, { quoted: m });
            } catch (e) {
                await sock.sendMessage(from, { text: '❌ *Could not fetch weather data!*' }, { quoted: m });
            }
            return;
        }

        // Sticker Command
        if (command === 's' || command === 'sticker') {
            const quotedMsg = m.message.extendedTextMessage?.contextInfo?.quotedMessage;

            if (!m.message.imageMessage && !m.message.videoMessage && !quotedMsg?.imageMessage && !quotedMsg?.videoMessage) {
                await sock.sendMessage(from, {
                    text: '❌ *Send/Reply to an image or video!*\n\nUsage: `.s` (with image/video)'
                }, { quoted: m });
                return;
            }

            await react('🎨');
            stats.stickers++;

            try {
                let target = quotedMsg ? {
                    key: {
                        remoteJid: from,
                        id: m.message.extendedTextMessage.contextInfo.stanzaId
                    },
                    message: quotedMsg
                } : m;

                const buffer = await downloadMediaMessage(
                    target,
                    'buffer',
                    {},
                    {
                        logger: pino({ level: 'silent' }),
                        reuploadRequest: sock.updateMediaMessage
                    }
                );

                await sock.sendMessage(from, { sticker: buffer }, { quoted: m });
            } catch (e) {
                await sock.sendMessage(from, {
                    text: '❌ *Failed to create sticker!*'
                }, { quoted: m });
            }
            return;
        }

        // Settings Command
        if (isOwner && command === 'settings') {
            const settingsText = `
╭━━━ *HDNOVA SETTINGS* ━━━╮
│
│ 👁️ Auto Status Seen: ${botSettings.autoStatusSeen ? '✅ ON' : '❌ OFF'}
│ 📥 Auto Status Download: ${botSettings.autoStatusDownload ? '✅ ON' : '❌ OFF'}
│ 📝 Auto Read: ${botSettings.autoRead ? '✅ ON' : '❌ OFF'}
│ 🛡️ Anti-Delete: ${botSettings.antiDelete ? '✅ ON' : '❌ OFF'}
│ 📵 Call Shield: ${botSettings.callShield ? '✅ ON' : '❌ OFF'}
│ 🔔 Owner Notifications: ${botSettings.ownerNotifications ? '✅ ON' : '❌ OFF'}
│
╰━━━━━━━━━━━━━━━━━━━━╯
`.trim();

            await sock.sendMessage(from, { text: settingsText }, { quoted: m });
            return;
        }

        // Stats Command
        if (isOwner && command === 'stats') {
            const uptime = process.uptime();
            const hours = Math.floor(uptime / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);

            const totalUsers = await User.countDocuments();
            const totalGroups = await Group.countDocuments();

            const statsText = `
╭━━━ *BOT STATISTICS* ━━━╮
│
│ 👥 *Total Users:* ${totalUsers}
│ 👥 *Total Groups:* ${totalGroups}
│ 💬 *Messages:* ${stats.totalMessages}
│ 🤖 *AI Requests:* ${stats.aiRequests}
│ ⏱️ *Uptime:* ${hours}h ${minutes}m
│ 💾 *Memory:* ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB
│
╰━━━━━━━━━━━━━━━━━━━━╯
`.trim();

            await sock.sendMessage(from, { text: statsText }, { quoted: m });
            return;
        }

        // Restart Command
        if (isOwner && command === 'restart') {
            await sock.sendMessage(from, { text: '🔄 *Restarting bot...*' }, { quoted: m });
            process.exit(0);
        }

    });

    // Anti-Delete System
    sock.ev.on('messages.update', async (updates) => {
        if (!botSettings.antiDelete) return;

        for (const update of updates) {
            if (update.update && update.update.message === null) {
                const messageId = update.key.id;
                const cached = messageStore.get(messageId);

                if (!cached) continue;

                const { remoteJid, sender, pushName, message } = cached;
                const msgType = Object.keys(message)[0];

                try {
                    await sock.sendMessage(ownerJid, {
                        text: `🛡️ *HDNOVA ANTI-DELETE*\n\n📌 *Chat:* @${remoteJid.split('@')[0]}\n👤 *Sender:* ${pushName}\n🗑️ *Type:* ${msgType.replace('Message', '')}\n⏰ *Time:* ${new Date().toLocaleTimeString()}`,
                        mentions: [sender]
                    });

                    if (['imageMessage', 'videoMessage', 'stickerMessage', 'audioMessage', 'documentMessage'].includes(msgType)) {
                        await sock.sendMessage(ownerJid, {
                            forward: {
                                key: { remoteJid, id: messageId },
                                message: message
                            }
                        });
                    } else {
                        let deletedText = message.conversation || message.extendedTextMessage?.text || "_Empty message_";
                        await sock.sendMessage(ownerJid, { text: `💬 *Content:* ${deletedText}` });
                    }
                } catch (e) {
                    console.log('Anti-delete error:', e);
                }
            }
        }
    });

    // Call Shield
    sock.ev.on('call', async (calls) => {
        if (!botSettings.callShield) return;

        for (const call of calls) {
            if (call.status === 'offer') {
                try {
                    await sock.sendMessage(call.from, {
                        text: '📵 *HDNOVA CALL SHIELD*\n\n_Calls are not allowed! Please send a text message instead._ 💬'
                    });

                    if (botSettings.ownerNotifications) {
                        await sock.sendMessage(ownerJid, {
                            text: `📵 *Call Blocked*\n\nFrom: @${call.from.split('@')[0]}\nTime: ${new Date().toLocaleTimeString()}`,
                            mentions: [call.from]
                        });
                    }
                } catch (e) {}
            }
        }
    });
}

// Start the bot
connectToWhatsApp();

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n⚠️ Shutting down gracefully...');
    await saveSettings();
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});
