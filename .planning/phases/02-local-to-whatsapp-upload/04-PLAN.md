---
phase: "02"
plan: "04"
type: gap_closure
wave: 1
depends_on: []
files_modified:
  - watcher.js
  - src/SyncManifest.js
autonomous: true
requirements:
  - TWO-WAY-SYNC
---

# Phase 02 Plan 04: Gap Closure 3 — Final 3 Gaps

**Input:** [02-VERIFICATION.md](file:///C:/Users/Emad/Documents/GitHub/whatsapp-watcher/.planning/phases/02-local-to-whatsapp-upload/02-VERIFICATION.md)
**Iteration:** 3 (prior closures: 02-PLAN → 02-SUMMARY, 03-PLAN → 03-SUMMARY)

> [!IMPORTANT]
> This plan closes the final 3 gaps identified in verification. All line numbers reference the CURRENT `watcher.js` (525 lines) and `SyncManifest.js` (96 lines).

## Wave 1: Fix All Three Gaps

### Task 1.1 — Reverse-check manifest entries against WhatsApp on startup (GAP-1 CRITICAL)

<task>
<read_first>
- watcher.js (lines 96-242 — the `client.on('ready')` handler, specifically the startup scan at lines 197-241)
- watcher.js (lines 162-187 — the existing revoked-tombstone handling in the history sync loop)
- src/SyncManifest.js (lines 76-83 — `getByMessageId()`, lines 90-92 — `entries()`, lines 85-88 — `delete()`)
</read_first>
<action>
**Problem:** When a WhatsApp message is revoked while the bot is offline, the revoked tombstone has a DIFFERENT `msg.id._serialized` than the original message stored in the manifest. So `manifest.getByMessageId(tombstone.id)` returns `undefined` and the local file is never deleted.

**Fix:** Add a new scan block in `watcher.js` AFTER the existing startup scan's offline-deletion loop (line 223) and BEFORE the offline-additions loop (line 225). Insert the following logic:

1. Add a comment: `// 1b. Reverse-check: verify each manifest entry still exists on WhatsApp`
2. Iterate `manifest.entries()` to get all `[filename, messageId]` pairs.
3. For each pair, wrap in try/catch:
   a. Call `const msg = await client.getMessageById(messageId);`
   b. If `msg` is null/undefined, OR `msg.type === 'revoked'`, OR `!msg.hasMedia`:
      - Determine `const filePath = path.join(groupFolder, filename);`
      - If `fs.existsSync(filePath)`, call `fs.unlinkSync(filePath);`
      - Call `manifest.delete(filename);`
      - Log: `console.log('🗑️ Removed file for revoked/missing WA message:', filename);`
4. In the catch block, log: `console.error('❌ Error checking manifest entry for', filename, ':', err);`
5. After the loop, log: `console.log('✅ Reverse manifest check complete.');`

**Placement detail:** This block goes between line 223 (the closing `}` of the existing offline-deletion `for` loop) and line 225 (the `// 2. Detect offline file additions` comment). Renumber existing comment `// 1.` to `// 1a.` and label this new block `// 1b.`.
</action>
<acceptance_criteria>
- Source assertion: A block labeled `// 1b. Reverse-check` exists in the startup scan section of the `ready` handler, AFTER the existing offline-deletion loop and BEFORE the offline-additions loop.
- Source assertion: The block calls `manifest.entries()` and iterates all `[filename, messageId]` pairs.
- Source assertion: Inside the loop, `client.getMessageById(messageId)` is called.
- Source assertion: The condition checks `!msg || msg.type === 'revoked' || !msg.hasMedia`.
- Source assertion: When the condition is true, `fs.unlinkSync(filePath)` is called (guarded by `fs.existsSync`), then `manifest.delete(filename)`.
- Source assertion: Each iteration is wrapped in try/catch to prevent one failure from blocking others.
- Behavior assertion: If a WhatsApp message tracked in the manifest is revoked while the bot is offline, on restart the corresponding local file is deleted and the manifest entry is removed.
</acceptance_criteria>
</task>

### Task 1.2 — Replace chokidar ignore regex with function and add SyncManifest retry (GAP-2 HIGH)

<task>
<read_first>
- watcher.js (lines 386-396 — the chokidar.watch() configuration, specifically line 390 with the regex)
- src/SyncManifest.js (lines 55-61 — the `_save()` method with `writeFileSync` and `renameSync`)
</read_first>
<action>
**Problem 1:** The chokidar `ignored` regex at line 390 is `/.*\.tmp$|^sync-manifest\.json$|^skipped-files\.log$/`. The `^...$` anchors on `sync-manifest.json` and `skipped-files.log` do NOT match because chokidar passes full absolute paths (e.g. `C:\...\sync-manifest.json`), not basenames. This means chokidar watches and locks `sync-manifest.json.tmp` via `awaitWriteFinish`, causing EPERM when `SyncManifest._save()` tries `renameSync`.

**Fix 1:** In `watcher.js` at line 390, replace the regex:
```
ignored: /.*\.tmp$|^sync-manifest\.json$|^skipped-files\.log$/,
```
with a function:
```
ignored: (filePath) => {
    const base = path.basename(filePath);
    return base.endsWith('.tmp') || base === 'sync-manifest.json' || base === 'skipped-files.log';
},
```

**Problem 2:** `SyncManifest._save()` has zero retry logic — a single transient EPERM on `renameSync` kills the save permanently.

**Fix 2:** In `src/SyncManifest.js`, replace the `_save()` method (lines 55-61) with retry logic:
```js
_save() {
    const json = JSON.stringify(this._data, null, 2);
    const tmpPath = this.manifestPath + '.tmp';

    fs.writeFileSync(tmpPath, json, 'utf8');

    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 100;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            fs.renameSync(tmpPath, this.manifestPath);
            return;
        } catch (err) {
            if (attempt >= MAX_RETRIES) {
                throw err;
            }
            const start = Date.now();
            while (Date.now() - start < RETRY_DELAY_MS) {
                // busy-wait for retry delay (sync context)
            }
        }
    }
}
```
The busy-wait is appropriate here because `_save()` is already synchronous and called from sync methods (`set`, `delete`). A 100ms spin for transient EPERM is acceptable.
</action>
<acceptance_criteria>
- Source assertion: Line 390 in `watcher.js` no longer contains a regex. Instead, `ignored` is a function that calls `path.basename(filePath)` and checks `.endsWith('.tmp')`, `=== 'sync-manifest.json'`, and `=== 'skipped-files.log'`.
- Source assertion: `SyncManifest._save()` in `src/SyncManifest.js` contains a retry loop around `fs.renameSync(tmpPath, this.manifestPath)` with `MAX_RETRIES = 3`.
- Source assertion: The retry loop has a delay mechanism between attempts (busy-wait or equivalent sync delay of ~100ms).
- Source assertion: After exhausting all retries, the error is re-thrown (not silently swallowed).
- Behavior assertion: Chokidar no longer triggers events for `sync-manifest.json`, `skipped-files.log`, or any `.tmp` file regardless of the full path structure.
- Behavior assertion: Rapid manifest saves no longer crash with EPERM — transient file locks are retried.
</acceptance_criteria>
</task>

### Task 1.3 — Replace echo prevention with manifest-based check (GAP-3 HIGH)

<task>
<read_first>
- watcher.js (lines 465-521 — the `client.on('message_create')` handler, specifically lines 476-484 where the echo prevention logic is)
- src/SyncManifest.js (lines 76-83 — `getByMessageId()` method)
</read_first>
<action>
**Problem:** The echo prevention at lines 476-484 blocks ALL `fromMe` media messages that have a `msg.body` matching an existing local filename. This is too broad — when the bot owner sends a NEW file from their phone with a caption, it can get blocked if the caption coincidentally matches an existing file. The fundamental flaw is using filename existence as a proxy for "bot uploaded this".

**Fix:** In `watcher.js`, replace the entire echo-prevention block at lines 476-484:
```js
        if (msg.id.fromMe && msg.body && groupFolder) {
            const path = require('path');
            const fs = require('fs');
            const potentialEchoPath = path.join(groupFolder, msg.body);
            if (fs.existsSync(potentialEchoPath)) {
                console.log(`🔄 Ignoring echo of our own upload: ${msg.body}`);
                return;
            }
        }
```
with a manifest-based check:
```js
        if (msg.id.fromMe && manifest && manifest.getByMessageId(msg.id._serialized)) {
            console.log(`🔄 Ignoring echo of our own upload: ${msg.id._serialized}`);
            return;
        }
```

This skips a `fromMe` message ONLY if its exact message ID is already tracked in the manifest, which means the bot uploaded it. User messages from the owner's phone will not have their message IDs in the manifest, so they will be downloaded normally.

Note: The redundant `const path = require('path');` and `const fs = require('fs');` inside this block are also removed — `path` and `fs` are already imported at lines 3-4.
</action>
<acceptance_criteria>
- Source assertion: Lines 476-484 no longer contain `msg.body`, `potentialEchoPath`, `fs.existsSync(potentialEchoPath)`, or the inner `const path = require('path')` / `const fs = require('fs')` re-imports.
- Source assertion: The echo check is exactly: `if (msg.id.fromMe && manifest && manifest.getByMessageId(msg.id._serialized))` followed by a `return`.
- Source assertion: `manifest.getByMessageId(msg.id._serialized)` is the sole criterion for identifying bot-uploaded messages — no filename or body comparison.
- Behavior assertion: When the bot owner sends a NEW photo/document from their phone to the group, it IS downloaded to the local folder (not blocked by echo prevention).
- Behavior assertion: When the bot uploads a file from the local folder, the resulting `message_create` event for that upload IS blocked (because `manifest.getByMessageId` returns the filename for that message ID).
</acceptance_criteria>
</task>

## Edge Coverage & Must Haves

```yaml
must_haves:
  truths:
    - "GAP-1: On startup, every manifest entry is verified against WhatsApp via client.getMessageById(). If the message is null, revoked, or has no media, the local file is deleted and manifest entry removed."
    - "GAP-2: Chokidar ignored option uses a function with path.basename() — not a regex with ^ or $ anchors — so sync-manifest.json and skipped-files.log are properly excluded regardless of full path."
    - "GAP-2: SyncManifest._save() retries renameSync up to 3 times with 100ms delay between attempts before throwing."
    - "GAP-3: Echo prevention uses manifest.getByMessageId(msg.id._serialized) — not msg.body or fs.existsSync — to determine if a fromMe message was bot-uploaded."
    - "GAP-3: Messages sent by the bot owner from their phone (fromMe=true) with captions ARE downloaded, not blocked."
  prohibitions:
    - "The chokidar ignored option must NOT use a regex with ^...$ anchors for sync-manifest.json or skipped-files.log."
    - "The echo prevention must NOT check msg.body or fs.existsSync to determine if a message is a bot echo."
    - "SyncManifest._save() must NOT silently swallow rename errors — after max retries, the error must be re-thrown."
    - "The reverse manifest check must NOT skip entries on error — each entry must be independently try/caught."
```

## Artifacts this phase produces

### Modified symbols in `watcher.js`
- **Startup scan block** (inside `client.on('ready')`) — new `// 1b. Reverse-check` loop added between existing offline-deletion scan and offline-additions scan
- **Chokidar `ignored` option** (line 390) — changed from regex to function using `path.basename()`
- **Echo prevention block** (lines 476-484) — replaced `msg.body` + `fs.existsSync` check with `manifest.getByMessageId(msg.id._serialized)` check; removed redundant `require('path')` and `require('fs')` re-imports

### Modified symbols in `src/SyncManifest.js`
- **`_save()` method** (lines 55-61) — added retry loop (3 attempts, 100ms delay) around `fs.renameSync`
