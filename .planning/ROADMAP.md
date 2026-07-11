# Milestone v1.1 Roadmap

## Phase 02: Local to WhatsApp Upload
**Goal:** Implement two-way sync — local file additions upload to WhatsApp, local deletions revoke WA messages, WA deletions delete local files, offline changes reconcile on startup
**Requirements:** TWO-WAY-SYNC
**Status:** Executed — gaps remaining
**Success Criteria:**
- Files placed in the local folder are uploaded to WhatsApp with filename as caption
- Deleting a local file revokes the corresponding WhatsApp message
- Revoking a WhatsApp message deletes the corresponding local file
- Offline changes (additions, deletions, revocations) are reconciled on startup
- Upload rate limiting prevents WhatsApp bans
- Large files (>64MB) are skipped gracefully

## Phase 04: Discovery & Mapping
**Goal:** Identify all dependencies required by `watcher.js`
**Requirements:** CLEAN-01
**Success Criteria:**
- Complete list of all local file dependencies of `watcher.js` is generated.

## Phase 05: Code Deletion
**Goal:** Delete all source files and folders not needed by `watcher.js`
**Requirements:** CLEAN-02, CLEAN-03
**Success Criteria:**
- No unneeded `.js` files exist in the project directory.
- Unneeded folders (e.g. plugins, old components) are deleted.

## Phase 06: Finalize & Verify
**Goal:** Clean `package.json` and verify the app works correctly
**Requirements:** CLEAN-04, CLEAN-05
**Success Criteria:**
- `package.json` only contains dependencies actually imported/used by the remaining code.
- The application starts and runs without any module not found errors.
