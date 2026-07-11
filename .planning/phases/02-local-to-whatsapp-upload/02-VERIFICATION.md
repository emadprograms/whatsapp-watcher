---
phase: "02"
status: failed
verified_at: "2026-07-11T03:30:00Z"
gaps_found: 3
---

# Phase 02 Verification Report

## Status: FAILED — 3 gaps remaining

## Gaps

### GAP-1: Offline WhatsApp Deletions Not Syncing to Local (CRITICAL)
**UAT Test:** 9
**Debug file:** offline-whatsapp-revoke-sync.md
**Expected:** When someone deletes/revokes a message on WhatsApp while the bot is offline, on restart the corresponding local file should be deleted.
**Actual:** The local file is NOT deleted. The server does nothing on reconnect for offline revocations.
**Root cause:** The history sync loop at lines 162-187 handles `msg.type === 'revoked'` tombstones, but revoked message tombstones lose their original message ID — `manifest.getByMessageId(msg.id._serialized)` returns `undefined` because the tombstone ID differs from the original message ID stored in the manifest. Additionally, there is no reverse check during the startup scan: iterating manifest entries to verify each tracked message still exists on WhatsApp.
**Fix required:** During startup, iterate all manifest entries. For each `[filename, messageId]`, call `client.getMessageById(messageId)`. If the message is null, revoked, or no longer has media, delete the local file and remove the manifest entry. This is the reverse direction of the existing offline-deletion scan (which checks for local files missing → revoke WA message).

### GAP-2: Chokidar Ignore Regex Doesn't Match Full Paths → EPERM on SyncManifest (HIGH)
**UAT Test:** 10
**Debug file:** sync-manifest-eperm.md
**Expected:** The sync manifest should update without EPERM errors.
**Actual:** `EPERM: operation not permitted, rename sync-manifest.json.tmp -> sync-manifest.json` during rapid saves.
**Root cause:** The chokidar ignore regex `/.*\.tmp$|^sync-manifest\.json$|^skipped-files\.log$/` at line 390 uses `^...$` anchors on `sync-manifest.json` and `skipped-files.log`. Chokidar passes full absolute paths (e.g. `C:\...\sync-manifest.json`), NOT basenames, so the anchored patterns never match. Chokidar therefore polls `sync-manifest.json.tmp` via `awaitWriteFinish`, locking it while `SyncManifest._save()` tries to `renameSync`. Additionally, `SyncManifest._save()` has zero retry logic — a single transient EPERM kills the save.
**Fix required:**
1. Replace the regex with a function-based ignore that checks `path.basename()` — or remove `^` and `$` anchors so the patterns match anywhere in the path.
2. Add retry logic (3 attempts, 100ms delay) to `SyncManifest._save()` around the `renameSync` call.

### GAP-3: Echo Prevention Blocks Legitimate User Downloads (HIGH)
**UAT Test:** 1
**Debug file:** whatsapp-to-local-broken.md
**Expected:** New documents sent to the WhatsApp group (including by the bot owner from their phone) should be downloaded to the local folder.
**Actual:** Messages from the bot owner's phone (`msg.id.fromMe = true`) with a body are blocked by the echo prevention logic at line 476.
**Root cause:** The echo prevention at `if (msg.id.fromMe && msg.body && groupFolder)` is too broad. It checks if `msg.body` matches a filename that exists on disk. But when the user sends a NEW file from their phone, the filename doesn't exist yet — however the `msg.body` could match ANY existing file's name by coincidence, or future race conditions with the download. The fundamental issue is that the echo check should identify bot-uploaded messages specifically (by checking if the message ID is already in the manifest), not by checking if a file with the caption name exists on disk.
**Fix required:** Replace the echo check with: `if (msg.id.fromMe && manifest && manifest.getByMessageId(msg.id._serialized)) return;` — skip only if the manifest already tracks this exact message ID (meaning the bot uploaded it). Remove the `msg.body` / `fs.existsSync` check entirely.
