# Potential Race Conditions to Fix Later

Here are the most notable potential race condition scenarios in the current architecture:

### 1. Rapid Delete After Add (The "Ghost File" on WhatsApp)

- **Trigger:** A user drops a large file into the sync folder, triggering an `add` event. A moment later (while the script is reading the file into memory or mid-upload), the user deletes the file.
- **The Race:** The Chokidar `unlink` event fires immediately. However, the `unlink` handler checks if the file is in the `manifest`. Because the upload hasn't finished, the file isn't in the manifest yet, so the deletion is safely "ignored" by the delete handler. Later, the upload finishes, the script tries to rename the local file, fails (because it was deleted), catches the error, but **still adds it to the manifest**.
- **Result:** The file is fully uploaded to WhatsApp and tracked in the manifest, but missing locally. It stays stuck on WhatsApp until the script restarts, at which point the startup scan will finally notice the discrepancy and revoke the message.

### 2. Rapid Restore of a Deleted File (The "Orphaned Local File")

- **Trigger:** A user deletes a synced file, realizes their mistake, and immediately presses "Undo" (restoring the file) within a fraction of a second.
- **The Race:** The deletion pushes the file to the `deleteQueue`. The restore pushes it to the `uploadQueue`. The upload processor looks at the file, checks `manifest.has(filename)`, and says _"Oh, this is already tracked, skip it!"_ because the delete processor hasn't finished reaching out to WhatsApp to revoke the message yet. Moments later, the delete processor finishes, revokes the message, and removes it from the manifest.
- **Result:** The local file sits in the folder completely untracked. It won't be synced to WhatsApp unless it is modified or the script is restarted.

### 3. Atomicity Crash during Download (False Revocation on Reboot)

- **Trigger:** An incoming WhatsApp message contains media. The script downloads it to a `.tmp` file, adds the new ID to the `manifest`, and is just about to rename the `.tmp` to the final filename when the Node process crashes or the computer loses power.
- **The Race:** The manifest saved the new entry, but the final file doesn't exist locally yet (only the ignored `.tmp` does). On the next boot, the startup scan sees a tracked file in the manifest that is missing from the local folder. It assumes you deleted it while the script was offline.
- **Result:** The startup scan will immediately reach out to WhatsApp and revoke the perfectly good message that someone just sent you.

### 4. Cross-Device Caption Collision

- **Trigger:** The script is currently uploading a local file named `invoice.pdf`. At the exact same moment, you use your WhatsApp app on your phone to send a different file to the group, and you manually type the caption `invoice.pdf`.
- **The Race:** To prevent downloading its own uploads (echoes), the script uses an `uploadingFiles` Set. It ignores incoming messages if `msg.id.fromMe` is true and the caption (`msg.body`) matches a filename currently in `uploadingFiles`. Because your phone's message arrives while the script is uploading, it sees a message from you with the caption `invoice.pdf` and falsely assumes it's an echo of its own local upload.
- **Result:** The completely separate file sent from your phone is ignored and never downloaded to the local sync folder.

**Summary:**
Most of these are extreme edge cases requiring precise timing. To mitigate them entirely, you would need to introduce a lock manager or unified state machine that prevents `add` and `unlink` events for the same file from being evaluated concurrently, as well as deferring `manifest` writes until after file system operations (like `.tmp` renaming) are guaranteed to have completed.
