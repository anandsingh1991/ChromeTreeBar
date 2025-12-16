# ChromeBar - Feature Documentation

A Chrome extension for managing browser tabs in a hierarchical tree structure via a side panel.

## Core Features

### 1. Side Panel Tab Tree
- Displays all tabs in current window as a tree structure using Fancytree library
- Shows tab favicon and title for each tab
- Highlights the currently active tab
- Supports expand/collapse of parent nodes
- Uses all additional icons required from this https://fonts.googleapis.com/icon?family=Material+Icons

### 2. Tab Hierarchy (Parent-Child Relationships)
- Tabs can be nested under other tabs as children
- Drag-and-drop to reorganize tab hierarchy
- Drop on empty area to move tab to root level
- Tree structure persists across browser sessions via `chrome.storage.local`

### 3. Multi-Select
- **Ctrl/Cmd + Click**: Toggle individual tab selection
- **Shift + Click**: Select range of tabs between last clicked and current
- Visual highlight (`.multi-selected` class) for selected tabs
- Move multiple selected tabs at once during drag-drop

### 4. Tab Operations
- **Click**: Activate/switch to that tab
- **Close tab**: Via close button
- Real-time sync with browser tab events

### 5. Real-Time Sync
Listens to Chrome tab events and updates UI:
- `TAB_CREATED`: New tab added to tree
- `TAB_REMOVED`: Tab removed from tree
- `TAB_UPDATED`: Title, favicon, URL changes
- `TAB_ACTIVATED`: Active tab highlight updates
- `TAB_MOVED`: Tree reloads

## Technical Architecture

### Files Structure
```
ChromeBar/
├── manifest.json          # Extension manifest (Manifest V3)
├── background.js          # Service worker - tab lifecycle, tree storage
├── sidepanel/
│   ├── sidepanel.html     # Side panel UI
│   ├── sidepanel.js       # Fancytree initialization, event handlers
│   └── sidepanel.css      # Styling
├── lib/
│   ├── jquery.min.js
│   ├── jquery.fancytree-all-deps.min.js
│   └── ui.fancytree.min.css
└── icons/
```

### Key Technologies
- **Fancytree**: jQuery tree widget with dnd5 extension for drag-drop
- **Chrome Extensions API**: Manifest V3, Side Panel API, Tabs API, Storage API
- **jQuery**: DOM manipulation

### Data Structures

**Tab Node (stored in background.js tabTree Map):**
```javascript
{
  tabId: number,
  windowId: number,
  parentId: number | null,
  children: number[],
  title: string,
  url: string,
  favIconUrl: string,
  active: boolean,
  level: number
}
```

**Fancytree Node:**
```javascript
{
  key: string,        // tabId as string
  title: string,
  expanded: boolean,
  children: [],
  data: {
    tabId, windowId, url, active, favIconUrl
  }
}
```

### Message Types (background ↔ sidepanel)

| Message | Direction | Purpose |
|---------|-----------|---------|
| `GET_TREE` | sidepanel → background | Request current tree structure |
| `UPDATE_TREE` | sidepanel → background | Save tree after drag-drop |
| `CLOSE_TAB` | sidepanel → background | Close a tab |
| `ACTIVATE_TAB` | sidepanel → background | Switch to a tab |
| `TAB_CREATED` | background → sidepanel | Notify new tab |
| `TAB_REMOVED` | background → sidepanel | Notify tab closed |
| `TAB_UPDATED` | background → sidepanel | Notify tab changed |
| `TAB_ACTIVATED` | background → sidepanel | Notify active tab changed |
| `TAB_MOVED` | background → sidepanel | Notify tab moved |


## CSS Classes

| Class | Purpose |
|-------|---------|
| `.active-tab` | Currently active browser tab |
| `.multi-selected` | Tab in multi-selection |
| `.fancytree-drop-target` | Drop target highlight during drag |
| `.tab-favicon` | Favicon image |
| `.tab-title-text` | Tab title text |


