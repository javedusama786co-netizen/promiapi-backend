const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const fs = require('fs');
const BotReply = require('../models/BotReply'); 

// Memory spaces telemetry caches rakhne ke liye
const qrStore = {}; 
const activeSessions = {}; // 🌟 FIX: Active user connections memory cache jahan live sockets save honge

// Har user ka session alag folder mein save hoga
async function connectToWhatsApp(userId) {
    const sessionDir = `./sessions/user_${userId}`;
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, 
    });

    sock.ev.on('creds.update', saveCreds);

    // Jab connection update ho
    sock.ev.on('connection.update', (update) => {
        const { connection, qr, lastDisconnect } = update;
        
        if (qr) {
            console.log(`QR Code generated for user ${userId}. Saving to store.`);
            qrStore[userId] = qr; 
        }
        
        if (connection === 'open') {
            console.log(`WhatsApp connected for user: ${userId}`);
            delete qrStore[userId]; 
            
            // 🌟 FIX: Active socket session runtime tracker me register kar diya
            activeSessions[userId] = sock; 
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
            console.log(`Connection closed for user ${userId}. Reconnecting: ${shouldReconnect}`);
            
            // Cleanup tracking structures on strict disconnects
            delete activeSessions[userId];
            
            if (shouldReconnect) {
                connectToWhatsApp(userId);
            }
        }
    });

    // Message Aane Par Reply Logic (Asli Auto-Responder Webhook Logic)
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const messageBody = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        if (!messageBody) return;
        console.log(`Incoming Message from ${sender} (User Account: ${userId}): ${messageBody}`);
        
        try {
            // 🌟 FIX: Multi-tenant safety: Sirf ISI user ke banaye hue active rules fetch honge
            const rules = await BotReply.find({ userId, isActive: true });
            let replyFound = null;

            for (const rule of rules) {
                const incomingMsg = messageBody.toLowerCase().trim();
                const keywordRule = rule.keyword.toLowerCase().trim();

                if (rule.matchType === "exact" && incomingMsg === keywordRule) {
                    replyFound = rule.replyText;
                    break;
                } else if (rule.matchType === "contains" && incomingMsg.includes(keywordRule)) {
                    replyFound = rule.replyText;
                    break;
                }
            }

            if (replyFound) {
                console.log(`Match Found! Sending Auto-Reply: "${replyFound}" to ${sender}`);
                await sock.sendMessage(sender, { text: replyFound });
            }
        } catch (error) {
            console.error("Error in bot auto-reply logic:", error);
        }
    });

    return sock;
}

// Frontend controller ke liye QR fetch karne ka helper function
const getQR = (userId) => {
    return qrStore[userId] || null;
};

// 🌟 NEW FIX: Manual Campaign/Messages controllers ke socket proxy fetcher engine
const getWhatsAppSession = (userId) => {
    return activeSessions[userId] || null;
};

module.exports = { connectToWhatsApp, getQR, getWhatsAppSession };