# ChromeTreeBar - Chrome Web Store Publishing Guide

## ✅ Pre-Publishing Checklist

Your extension is ready to publish! Here's what's been verified:

- ✅ Valid `manifest.json` (Manifest V3)
- ✅ All required icons present (16x16, 48x48, 128x128)
- ✅ Store description prepared (`STORE_DESCRIPTION.md`)
- ✅ Privacy policy prepared (`PRIVACY_POLICY.md`)
- ✅ Distribution package created: `chromebar-v1.0.0.zip`

---

## 📦 Publishing to Chrome Web Store

### Step 1: Create a Chrome Web Store Developer Account

1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. Sign in with your Google account
3. Pay the one-time **$5 USD developer registration fee**
4. Accept the Chrome Web Store Developer Agreement

### Step 2: Upload Your Extension

1. In the Developer Dashboard, click **"New Item"**
2. Click **"Choose file"** and select `chromebar-v1.0.0.zip`
3. Wait for the upload to complete (it will automatically validate your extension)

### Step 3: Fill Out the Store Listing

#### **Product Details**

- **Language:** English (or your primary language)
- **Item name:** ChromeTreeBar
- **Summary:** Short description (132 characters max)
  ```
  Manage Chrome tabs in a tree structure with drag-and-drop, tab groups, bookmarks integration, and instant search
  ```

- **Description:** Copy the content from `STORE_DESCRIPTION.md`

#### **Category**
- **Primary Category:** Productivity

#### **Privacy Practices**

1. **Privacy Policy:** 
   - You need to host your privacy policy on a publicly accessible URL
   - Options:
     - Create a GitHub repository and use GitHub Pages
     - Use GitHub Gist (easier): https://gist.github.com/
     - Host on your own website
   - Copy the content from `PRIVACY_POLICY.md`

2. **Single Purpose Description:**
   ```
   ChromeTreeBar organizes Chrome tabs into a hierarchical tree structure in a side panel, allowing users to manage tabs through drag-and-drop, integrate with native tab groups, access bookmarks, and search across open tabs.
   ```

3. **Permission Justifications:**
   - **tabs:** Read tab titles and URLs to display them in the side panel tree
   - **tabGroups:** Access and modify Chrome Tab Groups to reflect them in the tree
   - **bookmarks:** Display user bookmarks in the side panel for quick access
   - **sidePanel:** Render the extension's UI in the browser side panel
   - **storage:** Save tree structure and settings locally on the user's device
   - **host_permissions (<all_urls>):** Fetch favicons for tabs and bookmarks

4. **Data Usage:**
   - Select "Does NOT collect or use user data"
   - This extension processes all data locally

5. **Certification:**
   - Certify that your extension complies with Chrome Web Store policies

#### **Store Listing Assets**

You'll need to prepare the following images:

1. **Icon** (already done ✅)
   - 128x128 PNG (you have `icons/icon128.png`)

2. **Screenshots** (REQUIRED - at least 1, max 5)
   - Size: 1280x800 or 640x400 pixels
   - Format: PNG or JPEG
   - **Action Required:** Take screenshots of your extension in use
   - Recommended screenshots:
     - Main tree view with tabs organized
     - Drag-and-drop in action
     - Tab groups integration
     - Bookmarks section
     - Search functionality

3. **Promotional Images** (OPTIONAL but recommended)
   - Small Promo Tile: 440x280 PNG
   - Marquee Promo Tile: 1400x560 PNG
   - These appear in Chrome Web Store promotions

#### **Distribution**

- **Visibility:** 
  - Choose "Public" (visible to everyone)
  - Or "Unlisted" (only accessible via direct link)
- **Regions:** Select regions where you want to distribute (or select "All Regions")

### Step 4: Submit for Review

1. Click **"Submit for Review"**
2. Google will review your extension (usually takes 1-3 business days, but can take up to a week)
3. You'll receive an email notification once it's published or if changes are needed

---

## 📸 Creating Screenshots (Required!)

You need at least 1 screenshot. Here's how to create them:

### Option 1: Manual Screenshots
1. Open Chrome and load your extension
2. Open the side panel (Alt+C or click the extension icon)
3. Take screenshots showing key features:
   - Main tree interface
   - Tab groups in action
   - Bookmarks section
   - Search results
4. Resize to 1280x800 or 640x400 using an image editor

### Option 2: Use Browser DevTools
1. Press F12 to open DevTools
2. Toggle device toolbar (Ctrl+Shift+M / Cmd+Shift+M)
3. Set custom dimensions (1280x800)
4. Take screenshot

---

## 🌐 Hosting Your Privacy Policy

### Quick Option: GitHub Gist

1. Go to https://gist.github.com/
2. Create a new Gist:
   - Filename: `privacy-policy.md`
   - Content: Copy from `PRIVACY_POLICY.md`
3. Click "Create public gist"
4. Copy the Gist URL and use it in the Chrome Web Store form

### Alternative: GitHub Pages

1. Create a new GitHub repository (e.g., `chromebar-privacy`)
2. Add `PRIVACY_POLICY.md` as `index.md` or `privacy.html`
3. Enable GitHub Pages in repository settings
4. Use the Pages URL in the Chrome Web Store form

---

## 🔄 Updating Your Extension

When you need to update:

1. Update the `version` in `manifest.json` (e.g., `1.0.0` → `1.0.1`)
2. Create a new ZIP file: 
   ```bash
   cd /Volumes/workplace/ChromeBar
   zip -r chromebar-v1.0.1.zip manifest.json background.js icons/ sidepanel/ lib/ -x "*.DS_Store" "*.git*"
   ```
3. Go to the Developer Dashboard
4. Click on your extension
5. Click "Package" tab → "Upload new package"
6. Submit for review

---

## 📋 Important Notes

### Review Process
- **First submission:** Can take 3-7 days
- **Updates:** Usually faster (1-3 days)
- **Common rejection reasons:**
  - Missing or invalid privacy policy URL
  - Insufficient permission justifications
  - Misleading description or screenshots
  - Security vulnerabilities

### Best Practices
- Respond promptly to any review feedback
- Keep your privacy policy URL active and accessible
- Test your extension thoroughly before submitting updates
- Monitor user reviews and respond to issues

### Monetization
Your extension is currently free. If you want to monetize later:
- Add in-app purchases
- Use Chrome Web Store payments
- Note: Changing to paid requires careful consideration of user experience

---

## 🚀 Post-Publishing

After your extension is published:

1. **Share your extension:**
   - URL format: `https://chrome.google.com/webstore/detail/[extension-id]`
   - You'll get the extension ID after publishing

2. **Monitor:**
   - Check user reviews regularly
   - Monitor crash reports in Developer Dashboard
   - Track install/uninstall metrics

3. **Promote:**
   - Share on social media
   - Add to your GitHub repository README
   - Submit to extension directories

---

## 📞 Support Resources

- [Chrome Web Store Developer Documentation](https://developer.chrome.com/docs/webstore/)
- [Extension Review Guidelines](https://developer.chrome.com/docs/webstore/program-policies/)
- [Branding Guidelines](https://developer.chrome.com/docs/webstore/branding/)
- [Developer Support](https://support.google.com/chrome_webstore/contact/dev_account_support)

---

## ✨ Your Extension Package

📦 **File:** `chromebar-v1.0.0.zip` (ready to upload!)

**Next Steps:**
1. Create screenshots (at least 1, recommended 3-5)
2. Host your privacy policy online
3. Go to Chrome Web Store Developer Dashboard
4. Upload and fill out the listing
5. Submit for review!

Good luck with your extension! 🎉
