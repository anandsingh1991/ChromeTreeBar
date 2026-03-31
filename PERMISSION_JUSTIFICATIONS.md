# ChromeTreeBar - Permission Justifications for Chrome Web Store

Copy and paste these exact justifications into the Chrome Web Store Privacy Practices tab.

---

## Single Purpose Description

**Field: Single Purpose Description**

```
ChromeTreeBar organizes Chrome tabs into a hierarchical tree structure in a side panel, allowing users to manage tabs through drag-and-drop, integrate with native tab groups, access bookmarks, and search across open tabs.
```

---

## Permission Justifications

### tabs
**Justification:**
```
Required to read tab titles and URLs to display all open tabs in the side panel tree view, and to enable tab operations like switching, closing, and creating new tabs.
```

### tabGroups
**Justification:**
```
Required to read and modify Chrome Tab Groups so they can be displayed in the tree structure and allow users to add/remove tabs from groups directly in the side panel.
```

### bookmarks
**Justification:**
```
Required to display user bookmarks in the side panel tree view alongside open tabs, allowing users to browse and open bookmarked pages without leaving the extension interface.
```

### sidePanel
**Justification:**
```
Required to render the extension's user interface in Chrome's side panel, which is the core functionality that displays the tab tree structure.
```

### storage
**Justification:**
```
Required to save the user's customized tree hierarchy, expansion states, and preferences locally using chrome.storage.local so settings persist between browser sessions.
```

### favicon
**Justification:**
```
Required to fetch and display website favicons (icons) next to each tab and bookmark in the tree view, making items visually recognizable by their website's icon.
```

### Host Permissions (<all_urls>)
**Justification:**
```
Required to access favicon URLs from any website the user visits, enabling the display of accurate website icons next to tabs and bookmarks in the tree view.
```

### Remote Code
**Justification:**
```
This extension loads Google Fonts (Roboto font and Material Icons) from Google's CDN (fonts.googleapis.com and fonts.gstatic.com) for UI styling. These are static font/icon resources, not executable code. All JavaScript libraries (jQuery and Fancytree) are bundled locally in the lib/ folder within the extension package.
```

---

## Data Usage Certification

**Select:** "Does NOT collect or use user data"

**Explanation:**
All data processing occurs entirely within the user's browser. No data is transmitted to external servers. Tab information, bookmarks, and user preferences are only accessed and stored locally using Chrome's Storage API.

---

## Additional Required Steps

### 1. Contact Email
- Go to **Account** tab in Chrome Web Store Developer Dashboard
- Add your contact email address
- **Verify your email** by clicking the verification link sent to your inbox

### 2. Privacy Policy URL
You need to host your privacy policy and provide the URL. Quick options:

**Option A - GitHub Gist (Recommended):**
1. Go to https://gist.github.com/
2. Create new Gist with content from `PRIVACY_POLICY.md`
3. Make it public
4. Copy the Gist URL

**Option B - GitHub Pages:**
1. Create a repository
2. Add `PRIVACY_POLICY.md` 
3. Enable GitHub Pages
4. Use the Pages URL

### 3. Certification
After filling all the above:
- Check the box certifying compliance with Developer Program Policies
- This appears at the bottom of the Privacy Practices tab

---

## Checklist Before Submitting

- [ ] Account email added and verified
- [ ] Privacy policy hosted and URL added
- [ ] Single purpose description filled
- [ ] All 8 permission justifications filled (tabs, tabGroups, bookmarks, sidePanel, storage, favicon, host permissions, remote code)
- [ ] Data usage set to "Does NOT collect or use user data"
- [ ] Certification checkbox checked
- [ ] Screenshots uploaded (minimum 1)
- [ ] Category selected (Make Chrome Yours → Functionality & UI)

Once all items are checked, you can click "Submit for Review"!
