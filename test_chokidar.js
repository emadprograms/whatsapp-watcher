const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');

const basePath = path.join(process.env.USERPROFILE || process.env.HOME, 'Documents', 'syncstaging');
const OUT_DIR = path.join(basePath, 'out');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

console.log(`Test script will watch OUT_DIR: ${OUT_DIR}`);

const watcher = chokidar.watch(OUT_DIR, {
    ignoreInitial: true,
    awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100,
    }
});

watcher.on('add', p => console.log('✅ File ready to be uploaded:', p));
watcher.on('unlink', p => console.log('🗑️ File deleted (presumably uploaded):', p));
watcher.on('error', e => console.error('watcher error:', e));

setTimeout(() => {
    console.log('Simulating a file write in OUT_DIR...');
    
    // Simulate writing a file to OUT_DIR over a few seconds
    const targetFile = path.join(OUT_DIR, 'test_upload.bin');
    const fd = fs.openSync(targetFile, 'w');
    
    const buf = Buffer.alloc(1024 * 1024); // 1MB buffer
    let written = 0;
    
    const interval = setInterval(() => {
        fs.writeSync(fd, buf, 0, buf.length, null);
        written++;
        console.log(`Wrote ${written} MB...`);
        
        if (written > 5) { // 5 MB test file
            clearInterval(interval);
            fs.closeSync(fd);
            console.log('Done writing test file.');
            
            setTimeout(() => {
                watcher.close();
                console.log('Test complete. In a real run, watcher.js would upload this and delete it.');
                process.exit(0);
            }, 5000);
        }
    }, 500); // write 1 MB every 500ms
}, 1000);
