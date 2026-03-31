# Privacy Policy for ChromeTreeBar

**Effective Date:** February 21, 2026

Thank you for using ChromeTreeBar. This Privacy Policy outlines how your data is handled when you use the ChromeTreeBar browser extension.

## 1. Data Processing and Storage
ChromeTreeBar is designed with privacy as a core principle. **All data processing occurs entirely within your local browser.** 

- **Tab and Bookmark Data:** The extension accesses the URLs, titles, and favicons of your open tabs, tab groups, and bookmarks strictly to provide the core functionality of organizing and displaying them in the side panel tree structure.
- **Local Storage:** Your customized tree hierarchy and group settings are saved using the Chrome Storage API (`chrome.storage.local`). This data never leaves your device.

## 2. No External Transmissions
ChromeTreeBar **does not** transmit, upload, sell, or share any of your personal data, browsing history, tabs, or bookmarks to any external servers, third-party analytics providers, or external databases.

## 3. Required Permissions and their Justifications
The extension requests the following permissions for specific, functional purposes:
- **`tabs`**: Required to read the titles and URLs of your open tabs to display them in the side panel.
- **`tabGroups`**: Required to read and modify Chrome Tab Groups to reflect them in the hierarchical tree.
- **`bookmarks`**: Required to display and allow you to interact with your bookmarks directly from the side panel.
- **`sidePanel`**: Required to render the extension's user interface alongside your web content.
- **`storage`**: Required to save your customized tree structure locally so it persists between browser sessions.
- **`favicon` & `<all_urls>` (Host Permissions)**: Required to fetch and display the correct favicons (website icons) for your open tabs and bookmarks to make the tree visually recognizable.

## 4. Changes to This Policy
If there are any material changes to how ChromeTreeBar handles your data, this Privacy Policy will be updated accordingly. Because the extension operates entirely locally without user accounts, we recommend reviewing this policy periodically on the Chrome Web Store listing.

## 5. Contact
If you have any questions about this Privacy Policy or how ChromeTreeBar handles your data, please contact the developer via the support link provided in the Chrome Web Store listing.
