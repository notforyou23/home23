# Agent Notes - COSMO IDE v2

**For AI Agents & Future Reference**

---

## Project Overview

**COSMO IDE v2** - AI-powered IDE with function calling, semantic search, and surgical code editing.

- **Tech Stack:** Node.js, Express, OpenAI, Anthropic, Monaco Editor
- **Purpose:** Full-featured IDE with AI assistant capabilities
- **Status:** Production-ready, fully portable

---

## Repository Structure

This repository has **TWO local installations** with different purposes:

### 📁 `/Users/jtr/_JTR23_/cosmo_ide_v2/` - STABLE VERSION
- **Purpose:** Daily use, personal coding work, ready for others to test
- **Ports:** 3405 (HTTP), 3406 (HTTPS)
- **Git:** Fully functional repository on `main` branch, synced with GitHub
- **Remote:** `https://github.com/notforyou23/cosmo_ide.git`
- **Rule:** Only update via `git pull` after testing changes in dev

### 📁 `/Users/jtr/_JTR23_/cosmo_ide_v2_dev/` - DEVELOPMENT VERSION
- **Purpose:** Experimenting, developing new features, breaking things safely
- **Ports:** 3407 (HTTP), 3408 (HTTPS)
- **Git:** Fully functional repository on `main` branch
- **Remote:** `https://github.com/notforyou23/cosmo_ide.git` (same as stable)
- **Rule:** All changes start here, test thoroughly before committing/pushing

**Note:** Both folders are independent git repositories pointing to the same GitHub remote. They are NOT subfolders of each other. This dual-folder setup allows safe development without breaking your daily-use version.

---

## Development Workflow

### When Adding New Features:

1. **Work in DEV folder**
   ```bash
   cd /Users/jtr/_JTR23_/cosmo_ide_v2_dev
   # Make changes
   npm start  # Test on port 3407
   ```

2. **Test alongside stable**
   - Dev runs on ports 3407/3408
   - Stable still works on 3405/3406
   - No conflicts - both can run simultaneously!

3. **Commit and push when working**
   ```bash
   git add .
   git commit -m "Add feature XYZ"
   git push origin main
   ```

4. **Pull into stable when ready**
   ```bash
   cd /Users/jtr/_JTR23_/cosmo_ide_v2
   git pull origin main
   # Restart if server is running
   ```

5. **If issues in stable - rollback**
   ```bash
   cd /Users/jtr/_JTR23_/cosmo_ide_v2
   git reset --hard <previous-commit>
   ```

### Important Notes:

- **Both folders have independent git repositories** - they are NOT linked by filesystem
- **`.env` files are different** - Each has correct ports for its purpose (gitignored, won't sync)
- **Changes push from dev** - Stable pulls those changes when you're ready
- **Cursor workspace is per-folder** - Opening a different folder creates a new workspace context

---

## Key Files to Know

### Configuration
- `.env` - API keys, ports (NEVER commit this!)
- `.env.example` - Template for new installations
- `.gitignore` - Excludes .env, node_modules, conversations/

### Server
- `server/server.js` - Main Express server, routes, HTTPS
- `server/ai-handler.js` - AI function calling loop (OpenAI/Claude)
- `server/tools.js` - Tool definitions & execution
- `server/codebase-indexer.js` - Semantic search

### Frontend
- `public/index.html` - Main UI (6400+ lines, monolithic)
- `public/css/styles.css` - Styles
- `public/js/` - Frontend modules (TODO: modularize)

### Documentation
- `README.md` - Public-facing documentation
- `PORTABILITY-AUDIT.md` - Portability assessment
- `HTTPS-SETUP.md` - SSL certificate setup
- `SURGICAL-EDITS.md` - Surgical edit format guide
- `AGENT-NOTES.md` - This file

---

## Important Rules for Agents

### ❌ NEVER DO:
1. **Delete .env** - Contains user's API keys
2. **Commit .env** - It's gitignored for security
3. **Hardcode paths/IPs** - App is now fully portable
4. **Edit stable folder directly** - Always work in dev first
5. **Push without testing** - Test in dev on port 3407 first

### ✅ ALWAYS DO:
1. **Test in dev folder first** - `/cosmo_ide_v2_dev/`
2. **Use environment variables** - For ports, API keys, config
3. **Maintain portability** - No `/Users/jtr/` hardcoded paths
4. **Update both .env files** - When adding new env vars
5. **Check git status before committing** - Avoid committing secrets

---

## Portability Features (Added Dec 2025)

The app is now **100% portable**:

✅ **Auto-detects network IP** - No hardcoded `192.168.x.x`
✅ **Cross-platform file reveal** - Works on macOS/Windows/Linux
✅ **Relative paths** - No user-specific paths
✅ **Environment-based config** - Ports, API keys in `.env`

### Network IP Detection
```javascript
// server/server.js
const os = require('os');
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  // Returns first non-internal IPv4 address
}
```

### Cross-Platform File Reveal
```javascript
// server/server.js - /api/reveal-in-finder
switch (os.platform()) {
  case 'darwin': // macOS
  case 'win32': // Windows  
  case 'linux': // Linux
}
```

---

## Common Tasks

### Start Server
```bash
npm start  # Production
npm run dev  # Development (auto-reload)
```

### Add New AI Tool
1. Define in `server/tools.js`
2. Add to both `toolDefinitions` (OpenAI) and `anthropicTools` (Claude)
3. Implement in `ToolExecutor.execute()`
4. Update system prompt in `server/ai-handler.js` if needed

### Change Ports
Edit `.env`:
```
PORT=3405
HTTPS_PORT=3406
```

### Regenerate SSL Certificates
```bash
cd ssl/
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes \
  -subj "/C=US/ST=Local/L=Local/O=COSMO IDE/OU=Dev/CN=YOUR_IP" \
  -addext "subjectAltName=IP:YOUR_IP,DNS:localhost"
```

---

## API Endpoints

### File Operations
- `GET /api/folder/browse?path=...` - List directory
- `GET /api/folder/read?path=...` - Read file
- `PUT /api/folder/write` - Write file
- `POST /api/folder/create` - Create file
- `DELETE /api/folder/delete` - Delete file

### AI
- `POST /api/chat` - AI chat with function calling (SSE streaming)

### Semantic Search
- `POST /api/index-folder` - Index codebase
- `POST /api/codebase-search` - Search by meaning

### Conversations
- `GET /api/conversations` - List saved conversations
- `POST /api/conversations` - Save conversation
- `PUT /api/conversations/:id` - Update conversation
- `DELETE /api/conversations/:id` - Delete conversation

---

## Environment Variables

Required in `.env`:
```bash
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
XAI_API_KEY=xai-...  # Optional (Grok)
PORT=3405
HTTPS_PORT=3406  # Optional
```

---

## Troubleshooting

### Port Already in Use
```bash
lsof -ti:3405 | xargs kill -9  # For stable
lsof -ti:3407 | xargs kill -9  # For dev
```

### Can't Start Server
1. Check `.env` exists and has API keys
2. Check `node_modules/` exists - run `npm install`
3. Check ports not in use
4. Verify you're in the correct folder (dev vs stable)

### Changes Not Appearing
1. Hard refresh browser (Cmd+Shift+R)
2. Restart server
3. Check you're editing the right folder (dev vs stable)

### Lost Cursor Context / Conversation History
If you lose Cursor's conversation history:
- This happens when folder paths change or get renamed
- Cursor stores workspace context based on folder path
- **Git is not affected** - Your repositories are still fine
- Solution: Just start a new conversation in the current folder
- Your code, commits, and git history are all safe

---

## Git Remotes

- **Origin:** `https://github.com/notforyou23/cosmo_ide.git`
- **Branch:** `main`

---

## Testing Checklist

Before pulling dev changes into stable:

- [ ] Server starts without errors
- [ ] Can browse folders
- [ ] Can open files in editor
- [ ] Can chat with AI
- [ ] AI tools execute properly
- [ ] File operations work
- [ ] Semantic search works (if using)
- [ ] No console errors in browser

---

## Version History

- **v1** - Initial COSMO IDE (monolithic, in `/cosmo_ide/`)
- **v2** - Clean rewrite with function calling (this repo)
- **Dec 2025** - Made fully portable, dual folder setup

---

## For Future Agents

When the user asks you to work on COSMO IDE:

1. **Ask which version:** Dev or Stable?
2. **Default to dev** for new features
3. **Test before committing**
4. **Keep this file updated** if workflow changes
5. **Respect the two-folder system** - it's intentional!

Remember: The user wants a **stable working IDE** for daily use, and a **dev environment** for experimentation. Don't break stable!

---

**Last Updated:** December 10, 2025  
**Current Commit:** c505c2e (Make app fully portable)
