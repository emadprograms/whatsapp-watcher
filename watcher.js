const { Client, LocalAuth, MessageMedia } = require('./index');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const mime = require('mime');
require('dotenv').config();

// === GLOBAL ERROR HANDLING ===
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Unhandled Rejection at:', promise, 'reason:', reason);
});

// === DIRECTORY SETUP ===
const basePath = path.join(process.env.USERPROFILE || process.env.HOME, 'Documents', 'syncstaging');
const IN_DIR = path.join(basePath, 'in');
const OUT_DIR = path.join(basePath, 'out');

if (!fs.existsSync(IN_DIR)) fs.mkdirSync(IN_DIR, { recursive: true });
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

let sendMeGroupId = null;
let receiveMeGroupId = null;

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
        ],
    },
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Stopping watcher...');
    if (client) {
        await client.destroy();
    }
    process.exit(0);
});

client.on('qr', (qr) => {
    console.log('QR RECEIVED. Please scan it with your WhatsApp app:');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    console.log('Successfully authenticated!');
});

client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failure:', msg);
});

client.on('disconnected', (reason) => {
    console.log('Disconnected:', reason);
});

client.on('ready', async () => {
    console.log('Client is ready!');

    const chats = await client.getChats();
    const groups = chats.filter((chat) => chat.isGroup);

    const sendMeGroup = groups.find(g => g.name.toLowerCase() === 'send me');
    const receiveMeGroup = groups.find(g => g.name.toLowerCase() === 'receive me');

    if (!sendMeGroup || !receiveMeGroup) {
        console.error('❌ Could not find "send me" or "receive me" groups.');
        console.log('Available groups:');
        groups.forEach(g => console.log(` - ${g.name} (ID: ${g.id._serialized})`));
        process.exit(1);
    }

    sendMeGroupId = sendMeGroup.id._serialized;
    receiveMeGroupId = receiveMeGroup.id._serialized;

    console.log(`✅ Bound to "send me" group: ${sendMeGroupId}`);
    console.log(`✅ Bound to "receive me" group: ${receiveMeGroupId}`);
    console.log(`📂 Monitoring OUT_DIR: ${OUT_DIR}`);
    console.log(`📂 Saving to IN_DIR: ${IN_DIR}`);

    // --- SETUP CHOKIDAR ON OUT DIRECTORY ---
    const fsWatcher = chokidar.watch(OUT_DIR, {
        ignoreInitial: true,
        awaitWriteFinish: {
            stabilityThreshold: 2000,
            pollInterval: 100,
        },
    });

    fsWatcher.on('error', (error) => console.error('Chokidar Watcher error:', error));

    fsWatcher.on('add', async (filePath) => {
        try {
            const filename = path.basename(filePath);
            console.log(`📤 Uploading file: ${filename}`);
            
            // Skip temporary or hidden files
            if (filename.startsWith('.') || filename.endsWith('.tmp')) return;

            const media = MessageMedia.fromFilePath(filePath);
            
            // Upload to receive me group
            await client.sendMessage(receiveMeGroupId, media, { caption: filename });
            console.log(`✅ Uploaded to WhatsApp: ${filename}`);
            
            // Delete from out folder
            fs.unlinkSync(filePath);
            console.log(`🗑️ Deleted from out folder: ${filename}`);
            
        } catch (err) {
            console.error(`❌ Failed to upload ${filePath}:`, err);
        }
    });
});

client.on('message_create', async (msg) => {
    // Only process messages in the "send me" group
    if (msg.from !== sendMeGroupId && msg.to !== sendMeGroupId) {
        return;
    }

    if (msg.hasMedia) {
        try {
            console.log(`📩 Detected media in "send me" group. Downloading...`);
            const media = await msg.downloadMedia();

            if (media) {
                const mimetypeStr = media.mimetype ? media.mimetype.split(';')[0] : '';
                const ext = mime.getExtension(mimetypeStr) || 'bin';
                
                let baseFilename = media.filename;
                if (!baseFilename) {
                    baseFilename = `download_${msg.id.id.slice(-5)}.${ext}`;
                } else if (!baseFilename.includes('.')) {
                    baseFilename = `${baseFilename}.${ext}`;
                }

                // If file already exists in IN_DIR, prepend timestamp
                let filePath = path.join(IN_DIR, baseFilename);
                if (fs.existsSync(filePath)) {
                    baseFilename = `${Date.now()}_${baseFilename}`;
                    filePath = path.join(IN_DIR, baseFilename);
                }

                fs.writeFileSync(filePath, media.data, { encoding: 'base64' });
                console.log(`✅ Saved to IN_DIR: ${filePath}`);

                // Attempt to delete message from WhatsApp
                // Use true to delete for everyone, false for me. Some messages can't be deleted for everyone.
                try {
                    await msg.delete(true);
                    console.log(`🗑️ Revoked message for everyone from WhatsApp`);
                } catch (delErr) {
                    try {
                        await msg.delete(false);
                        console.log(`🗑️ Deleted message for me from WhatsApp`);
                    } catch (delMeErr) {
                        console.warn(`⚠️ Could not delete message from WhatsApp:`, delMeErr.message);
                    }
                }
            }
        } catch (err) {
            console.error('❌ Failed to process incoming media:', err);
        }
    }
});

client.initialize();
