# HTTPS Setup Guide for COSMO IDE

Your COSMO IDE now runs with HTTPS support! 🔒

## Access URLs

**On this machine:**
- HTTP: http://localhost:3405
- HTTPS: https://localhost:3406 ✅

**From other devices on your network:**
- HTTP: http://YOUR_LOCAL_IP:3405
- HTTPS: https://YOUR_LOCAL_IP:3406 🔒 ✅ (Recommended)

> **💡 Finding YOUR_LOCAL_IP:**
> - The server displays it on startup (look for "network" in the output)
> - **macOS/Linux:** Run `ifconfig | grep "inet " | grep -v 127.0.0.1`
> - **Windows:** Run `ipconfig` and look for IPv4 Address

---

## Why HTTPS?

HTTPS enables:
- ✅ Full clipboard functionality in Monaco Editor
- ✅ Service Workers (if needed later)
- ✅ Modern browser APIs
- ✅ More secure connections

---

## Trust the Certificate (First Time Only)

Since this is a **self-signed certificate**, you'll need to trust it on each device.

### On This Mac (Safari/Chrome):

1. Open: https://localhost:3406
2. You'll see "Your connection is not private" or similar warning
3. Click **"Show Details"** → **"Visit this website"** → **"Visit Website"**
4. Done! ✅

**Alternative (Trust permanently in Keychain):**
1. Open **Keychain Access** app
2. File → Import Items → Select `ssl/cert.pem` from your COSMO IDE directory
3. Find the certificate (named with your IP address) → Double-click
4. Expand **"Trust"** → Set "When using this certificate" to **"Always Trust"**
5. Close (enter password when prompted)

### On iPhone/iPad (Safari):

1. **Transfer the certificate:**
   - Option A: Email yourself the `cert.pem` file from `ssl/` folder
   - Option B: Use AirDrop to send `cert.pem` to your iOS device

2. **Install the profile:**
   - Open the `.pem` file attachment
   - Tap "Allow" when asked to download profile
   - Go to **Settings** → **Profile Downloaded** → **Install**
   - Enter passcode → **Install** → **Install**

3. **Trust the certificate:**
   - Go to **Settings** → **General** → **About** → **Certificate Trust Settings**
   - Enable the toggle for your certificate (named with your IP)

4. Open Safari and visit: https://YOUR_LOCAL_IP:3406

### On Windows:

1. Open: https://YOUR_LOCAL_IP:3406
2. Click **"Advanced"** → **"Continue to [your IP]"**
3. For permanent trust:
   - Transfer `cert.pem` from the server to your Windows machine
   - Double-click → **Install Certificate**
   - Store Location: **Local Machine**
   - Place in: **Trusted Root Certification Authorities**
   - Click **Finish**

### On Android (Chrome):

1. **Transfer certificate:**
   - Email yourself `cert.pem` or use Google Drive

2. **Install certificate:**
   - Go to **Settings** → **Security** → **Install from storage**
   - Select `cert.pem`
   - Name it "COSMO IDE"
   - Credential use: **VPN and apps**

3. Visit: https://YOUR_LOCAL_IP:3406

---

## Certificate Info

- **Location:** `ssl/` folder in your COSMO IDE directory
- **Files:**
  - `cert.pem` - Certificate (share this to trust on other devices)
  - `key.pem` - Private key (keep secret!)
- **Valid for:** 365 days
- **Valid for:** Your local IP address and localhost

---

## Regenerate Certificate (If Needed)

If your IP changes or certificate expires, run:

```bash
# Navigate to your COSMO IDE ssl folder
cd ssl

# Generate new certificate (replace YOUR_LOCAL_IP with your actual IP)
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes \
  -subj "/C=US/ST=Local/L=Local/O=COSMO IDE/OU=Dev/CN=YOUR_LOCAL_IP" \
  -addext "subjectAltName=IP:YOUR_LOCAL_IP,DNS:localhost"
```

Then restart the server.

---

## Quick Start

1. **This machine:** Just visit https://localhost:3406 (accept warning once)
2. **Other devices:** 
   - Install certificate (see above)
   - Visit https://YOUR_LOCAL_IP:3406 (get IP from server startup message)
   - Enjoy full IDE features! 🎉
