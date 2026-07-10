const { Client, LocalAuth, MessageMedia } = require('./index');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ... (existing imports)
const SyncManifest = require('./src/SyncManifest');

// === GLOBAL ERROR HANDLING ===
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Unhandled Rejection at:', promise, 'reason:', reason);
});

// === HELPERS ===
// ... (existing helpers)

// === CONFIGURATION ===
// You can set this via environment variable: GROUP_ID=123456789@g.us node watcher.js
const TARGET_GROUP_ID = process.env.GROUP_ID;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

let manifest = null;
let isWatcherInitialized = false;
let groupFolder = null;

if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR);
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        executablePath:
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
        ],
    },
});

// Graceful shutdown: kill browser when user presses Ctrl+C
process.on('SIGINT', async () => {
    console.log('\n🛑 Stopping watcher...');
    process.exit(0);
});

client.on('qr', (qr) => {
    console.log('QR RECEIVED. Please scan it with your WhatsApp app:');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    console.log('Successfully authenticated!');

    // Watchdog to track progress towards 'ready'
    const watchdog = setInterval(async () => {
        try {
            const page = client.pupPage;
            if (page) {
                const title = await page.title();
                const url = page.url();
                console.log(
                    `🕒 Watchdog: Page Title: "${title}" | URL: ${url}`,
                );
            }
        } catch (e) {
            console.log(
                '🕒 Watchdog: Waiting for page to be available...',
                e.message,
            );
        }
    }, 5000);

    client.on('ready', () => {
        clearInterval(watchdog);
    });
});

client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failure:', msg);
});

client.on('disconnected', (reason) => {
    console.log('Disconnected:', reason);
});

client.on('ready', async () => {
    console.log('Client is ready!');

    if (!TARGET_GROUP_ID) {
        console.log(`
⚠️  No TARGET_GROUP_ID provided.`);
        console.log('Listing your groups so you can find the ID:');
        console.log('--------------------------------------------------');
        const chats = await client.getChats();
        const groups = chats.filter((chat) => chat.isGroup);

        groups.forEach((group) => {
            console.log(`Name: ${group.name} | ID: ${group.id._serialized}`);
        });
        console.log('--------------------------------------------------');
        console.log(`
To start watching a group, run:`);
        console.log(`GROUP_ID=your_group_id_here node watcher.js`);
        process.exit(0);
    } else {
        console.log(`Watching group: ${TARGET_GROUP_ID}`);

        groupFolder = path.join(DOWNLOADS_DIR, TARGET_GROUP_ID.split('@')[0]);
        if (!fs.existsSync(groupFolder))
            fs.mkdirSync(groupFolder, { recursive: true });
        manifest = new SyncManifest(
            path.join(groupFolder, 'sync-manifest.json'),
        );

        // --- SYNC EXISTING MEDIA ---
        try {
            console.log('🔄 Syncing recent media from group history...');
            const chat = await client.getChatById(TARGET_GROUP_ID);
            const messages = await chat.fetchMessages({ limit: 1000 });

            let downloadedCount = 0;
            for (const msg of messages) {
                if (msg.hasMedia) {
                    const media = await msg.downloadMedia();
                    if (media) {
                        let baseFilename = media.filename;
                        if (!baseFilename) {
                            const mime = require('mime');
                            const mimetypeStr = media.mimetype
                                ? media.mimetype.split(';')[0]
                                : '';
                            const ext = mime.getExtension(mimetypeStr) || 'bin';
                            baseFilename = `download.${ext}`;
                        }

                        const uniqueId = msg.id.id.slice(-5);
                        const filename = `${uniqueId}_${baseFilename}`;
                        const filePath = path.join(groupFolder, filename);

                        if (
                            !fs.existsSync(filePath) &&
                            !manifest.has(filename)
                        ) {
                            fs.writeFileSync(filePath + '.tmp', media.data, {
                                encoding: 'base64',
                            });
                            manifest.set(filename, msg.id._serialized);
                            fs.renameSync(filePath + '.tmp', filePath);
                            downloadedCount++;
                        }
                    }
                }
            }
            console.log(
                `✅ Sync complete. Downloaded ${downloadedCount} existing media files.`,
            );
        } catch (err) {
            console.error('❌ Error syncing group history:', err);
        }
        // ---------------------------

        // --- STARTUP SCAN (Offline Changes) ---
        console.log('🔍 Scanning for offline changes...');
        const startupUploadQueue = [];

        // 1. Detect offline file deletions (Tracked in manifest but missing locally)
        for (const [filename, messageId] of manifest.entries()) {
            try {
                if (!fs.existsSync(path.join(groupFolder, filename))) {
                    const msg = await client.getMessageById(messageId);
                    if (msg) {
                        await msg.delete(true);
                        console.log(
                            '🗑️ Revoked orphan message for deleted file:',
                            filename,
                        );
                    }
                    manifest.delete(filename);
                }
            } catch (err) {
                console.error(
                    '❌ Error processing offline deletion for',
                    filename,
                    ':',
                    err,
                );
            }
        }

        // 2. Detect offline file additions (Local files not tracked in manifest)
        const localFiles = fs.readdirSync(groupFolder);
        for (const filename of localFiles) {
            if (
                filename === 'sync-manifest.json' ||
                filename === 'skipped-files.log' ||
                filename.endsWith('.tmp') ||
                manifest.has(filename)
            ) {
                continue;
            }
            startupUploadQueue.push(path.join(groupFolder, filename));
            console.log('📤 Queued untracked local file for upload:', filename);
        }
        console.log(
            `✅ Startup scan complete. ${startupUploadQueue.length} files queued for upload.`,
        );

        // --- UPLOAD INFRASTRUCTURE ---
        if (isWatcherInitialized) return;
        isWatcherInitialized = true;

        const MAX_FILE_SIZE_BYTES = 64 * 1024 * 1024;
        const uploadQueue = [...startupUploadQueue];
        let isProcessingQueue = false;

        async function processUploadQueue() {
            isProcessingQueue = true;
            let consecutiveUploads = 0;
            while (uploadQueue.length > 0) {
                const filePath = uploadQueue.shift();
                const filename = path.basename(filePath);

                if (manifest.has(filename)) continue;
                if (!fs.existsSync(filePath)) continue;

                try {
                    const stat = fs.statSync(filePath);
                    if (stat.size > MAX_FILE_SIZE_BYTES) {
                        fs.appendFileSync(
                            path.join(groupFolder, 'skipped-files.log'),
                            `${new Date().toISOString()} | SIZE_SKIP | ${filename} | ${stat.size} bytes exceeds ${MAX_FILE_SIZE_BYTES} limit\n`,
                        );
                        continue;
                    }

                    const media = MessageMedia.fromFilePath(filePath);
                    let attempts = 0;
                    let success = false;
                    const MAX_RETRIES = 3;

                    while (attempts < MAX_RETRIES && !success) {
                        try {
                            const sentMsg = await client.sendMessage(
                                TARGET_GROUP_ID,
                                media,
                                {
                                    caption: filename,
                                },
                            );
                            manifest.set(filename, sentMsg.id._serialized);
                            console.log('✅ Uploaded:', filename);
                            success = true;
                        } catch (uploadErr) {
                            attempts++;
                            if (attempts >= MAX_RETRIES) {
                                throw uploadErr;
                            }
                            console.warn(
                                `⚠️ Upload failed for ${filename}. Retrying (${attempts}/${MAX_RETRIES})...`,
                            );
                            await new Promise((r) =>
                                setTimeout(r, Math.pow(2, attempts) * 1000),
                            );
                        }
                    }
                    consecutiveUploads++;
                    if (
                        consecutiveUploads % 10 === 0 &&
                        uploadQueue.length > 0
                    ) {
                        console.log(
                            `⏱️ Rate limit: Pausing for 60 seconds after ${consecutiveUploads} consecutive uploads...`,
                        );
                        await new Promise((r) => setTimeout(r, 60000));
                    } else if (uploadQueue.length > 0) {
                        if (consecutiveUploads >= 10) {
                            await new Promise((r) => setTimeout(r, 10000));
                        } else {
                            await new Promise((r) => setTimeout(r, 3000));
                        }
                    }
                } catch (err) {
                    fs.appendFileSync(
                        path.join(groupFolder, 'skipped-files.log'),
                        `${new Date().toISOString()} | SKIP | ${filename} | ${err.message}\n`,
                    );
                }
            }
            isProcessingQueue = false;
        }

        function enqueueUpload(filePath) {
            const filename = path.basename(filePath);
            if (
                filename === 'sync-manifest.json' ||
                filename === 'skipped-files.log' ||
                filename.endsWith('.tmp') ||
                manifest.has(filename)
            ) {
                return;
            }
            uploadQueue.push(filePath);
            if (!isProcessingQueue) {
                processUploadQueue().catch((err) =>
                    console.error('❌ Upload queue error:', err),
                );
            }
        }

        if (uploadQueue.length > 0 && !isProcessingQueue) {
            console.log(
                `▶️ Starting upload queue with ${uploadQueue.length} offline files...`,
            );
            processUploadQueue(groupFolder).catch((err) =>
                console.error('❌ Startup upload queue error:', err),
            );
        }

        try {
            const chokidar = await import('chokidar');
            const fsWatcher = chokidar.watch(groupFolder, {
                ignoreInitial: true,
                ignored:
                    /(^|[/\\])\.tmp$|sync-manifest\.json|skipped-files\.log/,
                awaitWriteFinish: {
                    stabilityThreshold: 2000,
                    pollInterval: 100,
                },
            });

            fsWatcher.on('add', (filePath) => {
                enqueueUpload(filePath);
            });

            fsWatcher.on('unlink', async (filePath) => {
                const filename = path.basename(filePath);
                if (
                    filename === 'sync-manifest.json' ||
                    filename === 'skipped-files.log' ||
                    filename.endsWith('.tmp')
                ) {
                    return;
                }
                if (!manifest.has(filename)) return;

                const messageId = manifest.getByFilename(filename);
                try {
                    const msg = await client.getMessageById(messageId);
                    if (msg) {
                        await msg.delete(true);
                        console.log(
                            '🗑️ Revoked WhatsApp message for deleted file:',
                            filename,
                        );
                    }
                } catch (err) {
                    console.error(
                        '❌ Error revoking message for deleted file',
                        filename,
                        ':',
                        err,
                    );
                } finally {
                    manifest.delete(filename);
                }
            });
        } catch (err) {
            console.error('❌ Failed to initialize chokidar watcher:', err);
        }

        console.log('Waiting for new media messages...');
    }
});

async function handleRevocation(msg, revokedMsg) {
    if (msg.from !== TARGET_GROUP_ID && msg.to !== TARGET_GROUP_ID) return;

    const messageId = msg.id._serialized;
    let filename = manifest.getByMessageId(messageId);

    if (!filename && revokedMsg) {
        filename = manifest.getByMessageId(revokedMsg.id._serialized);
    }

    if (!filename) return;

    const filePath = path.join(groupFolder, filename);
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log('🗑️ Deleted local file for revoked message:', filename);
        }
    } catch (err) {
        console.error(
            '❌ Error deleting local file for revoked message',
            filename,
            ':',
            err,
        );
    } finally {
        manifest.delete(filename);
    }
}

client.on('message_revoke_everyone', handleRevocation);
client.on('message_revoke_me', handleRevocation);

client.on('message_create', async (msg) => {
    console.log(
        `📩 Incoming message from: ${msg.from} | to: ${msg.to} | Has Media: ${msg.hasMedia}`,
    );

    // Only process messages from/to the target group
    if (msg.from !== TARGET_GROUP_ID && msg.to !== TARGET_GROUP_ID) {
        return;
    }

    if (msg.hasMedia) {
        if (msg.id.fromMe && msg.body && groupFolder) {
            const path = require('path');
            const fs = require('fs');
            const potentialEchoPath = path.join(groupFolder, msg.body);
            if (fs.existsSync(potentialEchoPath)) {
                console.log(`🔄 Ignoring echo of our own upload: ${msg.body}`);
                return;
            }
        }
        try {
            console.log(`Detected media from ${msg.from}. Downloading...`);
            const media = await msg.downloadMedia();

            if (media) {
                if (!fs.existsSync(groupFolder)) {
                    fs.mkdirSync(groupFolder, { recursive: true });
                }

                let baseFilename = media.filename;
                if (!baseFilename) {
                    const mime = require('mime');
                    const mimetypeStr = media.mimetype
                        ? media.mimetype.split(';')[0]
                        : '';
                    const ext = mime.getExtension(mimetypeStr) || 'bin';
                    baseFilename = `download.${ext}`;
                }

                const uniqueId = msg.id.id.slice(-5);
                const filename = `${uniqueId}_${baseFilename}`;
                const filePath = path.join(groupFolder, filename);

                fs.writeFileSync(filePath + '.tmp', media.data, {
                    encoding: 'base64',
                });
                if (manifest) {
                    manifest.set(filename, msg.id._serialized);
                }
                fs.renameSync(filePath + '.tmp', filePath);

                console.log(`✅ Saved: ${filePath}`);
            }
        } catch (err) {
            console.error('❌ Failed to download media:', err);
        }
    }
});

client.initialize();
