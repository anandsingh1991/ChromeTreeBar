// Global state (in-memory)
const tabTree = new Map();
const groupMap = new Map(); // Store Chrome Tab Groups
let isInitializing = false;
let initializationPromise = null;
const eventQueue = [];

// Initialize immediately on load (handles Service Worker wakeups)
initializationPromise = initializeTree();

// Allow opening the side panel by clicking the extension icon
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('Error setting panel behavior:', error));

// ... existing onInstalled/onStartup ...

async function initializeTree() {
  if (isInitializing) return initializationPromise;
  isInitializing = true;
  eventQueue.length = 0; // Clear queue

  try {
    // Queries in parallel
    const [tabs, groups] = await Promise.all([
      chrome.tabs.query({}),
      chrome.tabGroups.query({})
    ]);

    // Populate Group Map
    groupMap.clear();
    groups.forEach(g => groupMap.set(g.id, g));



    // Sort tabs by window and index to ensure logical processing order
    tabs.sort((a, b) => {
      if (a.windowId !== b.windowId) return a.windowId - b.windowId;
      return a.index - b.index;
    });

    const stored = await chrome.storage.local.get('tabTree');
    const storedTree = stored.tabTree || {};

    // Clear and rebuild to ensure we never have stale memory state
    tabTree.clear();

    // Iterate sorted tabs to build tree
    // PASS 1: Create Nodes (Restore state if available)
    for (const tab of tabs) {
      let parentId = null;
      let title = tab.title;

      // Try to recover state from storage
      if (storedTree[tab.id]) {
        // We persist valid parentId from storage to preserve structure
        // But we must validity check it later (or let the 2nd pass handle it)
        parentId = storedTree[tab.id].parentId;
        // Optionally restore custom title if we saved it? The current logic just uses tab.title from browser.
        // If user renamed tab in tree, we might want to keep it? 
        // Current implementation: onTabUpdated updates tree. 
        // If we want key persistence, we can use storedTree.title if available?
        // Let's stick to tab.title for now to ensure it matches browser url, unless we explicitly added renaming features.
      } else {
        // Fallback for new/unknown tabs active during startup
        parentId = determineParentId(tab, tabTree);
      }

      tabTree.set(tab.id, {
        tabId: tab.id,
        windowId: tab.windowId,
        index: tab.index,
        openerTabId: tab.openerTabId,
        parentId: parentId, // Set provisionally
        children: [],       // Will populate in Pass 2
        title: title,
        url: tab.url,
        favIconUrl: tab.favIconUrl,
        active: tab.active,
        groupId: tab.groupId, // Storing Group ID
        level: 0
      });
    }

    // PASS 2: Link Children (Robust against index order mismatch)
    tabTree.forEach(node => {
      // Validate Parent
      if (node.parentId && tabTree.has(node.parentId)) {
        const parent = tabTree.get(node.parentId);
        parent.children.push(node.tabId);
        // We could calculate level here if needed: node.level = parent.level + 1
      } else {
        // If parent doesn't exist (closed?), it becomes a root
        node.parentId = null;
        node.level = 0;
      }
    });

    // Cleanup: (Pass 2 basically implicitly handles "dead children" by generating the list from scratch)
    // We don't need the old filter block because we started with empty children arrays.

    saveTree();
  } finally {
    isInitializing = false;
    // Replay all buffered events that happened during the await
    if (eventQueue.length > 0) {
      console.log('Replaying buffered events:', eventQueue.length);
      for (const event of eventQueue) {
        await handleBufferedEvent(event);
      }
      eventQueue.length = 0;
    }
  }
}

// Logic adapted from Reference "Link Map"
function determineParentId(tab, currentTree, prevNodeOverride = null) {
  if (!currentTree) return null;

  // 1. New Tab / Empty Tab Check (Rule from Link Map)
  // If it's a generic "New Tab", it should be a root node (start of a new thought process)
  // We check pendingUrl because onCreated often has pendingUrl for the target, and url is empty.
  const url = tab.pendingUrl || tab.url || '';
  if (url === 'chrome://newtab/' || url === 'about:blank' || url === '') {
    return null;
  }

  const openerTabId = tab.openerTabId;
  let prevNode = prevNodeOverride;

  // If prevNode not provided, try to find it in currentTree (O(N) lookup but acceptable for init)
  if (!prevNode) {
    for (const [id, node] of currentTree) {
      if (node.windowId === tab.windowId && node.index === tab.index - 1) {
        prevNode = node;
        break;
      }
    }
  }

  // Rule 1: Default fall-through is Root (return null at end) unless logic matches

  if (prevNode) {
    // Case 2: Prev node IS the opener -> Nest under it
    if (openerTabId && prevNode.tabId === openerTabId) {
      return prevNode.tabId;
    }
    // Case 3: Prev node SHARES the same opener -> Sibling (same parent)
    if (openerTabId && prevNode.openerTabId === openerTabId) {
      return prevNode.parentId;
    }
    // Fallback: If we have an opener but pattern doesn't match, verify existence
    if (openerTabId && currentTree.has(openerTabId)) {
      return openerTabId;
    }
  } else {
    // First tab or no prev found -> Use opener if valid (direct child)
    if (openerTabId && currentTree.has(openerTabId)) {
      return openerTabId;
    }
  }

  return null;
}

async function handleBufferedEvent(event) {
  // Dispatch to appropriate handler
  // We strictly use the internal logic, avoiding the direct listeners to prevent loops
  // But since the listeners push to queue if isInit, we need separate implementations or carefully call logic
  // We will extract logic to functions
  switch (event.type) {
    case 'created': onTabCreated(event.data); break;
    case 'removed': onTabRemoved(event.data); break;
    case 'updated': onTabUpdated(event.data.tabId, event.data.changeInfo, event.data.tab); break;
    case 'activated': onTabActivated(event.data); break;
    case 'attached': onTabAttached(event.data.tabId, event.data.attachInfo); break;
    case 'detached': onTabDetached(event.data.tabId, event.data.detachInfo); break;
    case 'replaced': onTabReplaced(event.data.addedTabId, event.data.removedTabId); break;
  }
}

// ... (saveTree, buildTreeStructure unchanged) ...

// ... (listeners - onCreated, onRemoved, etc. unchanged) ...

async function notifySidepanel(type, data) {
  try {
    // Broadcast to all listening parts of the extension (sidepanel)
    // This is much more reliable than getViews() in MV3
    await chrome.runtime.sendMessage({ type, ...data });
  } catch (e) {
    // Ignore errors if no one is listening (e.g. sidepanel closed)
  }
}

function saveTree() {
  const treeObj = {};
  tabTree.forEach((node, id) => {
    treeObj[id] = node;
  });
  chrome.storage.local.set({ tabTree: treeObj });
}

function buildTreeStructure() {
  const roots = [];
  const nodeMap = new Map();

  tabTree.forEach((node, id) => {
    nodeMap.set(id, {
      key: String(id),
      title: node.title,
      expanded: true,
      children: [],
      data: {
        tabId: node.tabId,
        windowId: node.windowId,
        url: node.url,
        active: node.active,
        favIconUrl: node.favIconUrl
      }
    });
  });

  tabTree.forEach((node, id) => {
    const treeNode = nodeMap.get(id);
    if (node.parentId && nodeMap.has(node.parentId)) {
      nodeMap.get(node.parentId).children.push(treeNode);
    } else {
      roots.push(treeNode);
    }
  });

  return roots;
}

// --- Event Listeners with Buffering ---

chrome.tabs.onCreated.addListener(tab => {
  if (isInitializing) { eventQueue.push({ type: 'created', data: tab }); return; }
  onTabCreated(tab);
});

chrome.tabs.onRemoved.addListener(tabId => {
  if (isInitializing) { eventQueue.push({ type: 'removed', data: tabId }); return; }
  onTabRemoved(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (isInitializing) { eventQueue.push({ type: 'updated', data: { tabId, changeInfo, tab } }); return; }
  onTabUpdated(tabId, changeInfo, tab);
});

chrome.tabs.onActivated.addListener(activeInfo => {
  if (isInitializing) { eventQueue.push({ type: 'activated', data: activeInfo }); return; }
  onTabActivated(activeInfo);
});

chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  if (isInitializing) { eventQueue.push({ type: 'attached', data: { tabId, attachInfo } }); return; }
  onTabAttached(tabId, attachInfo);
});

chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
  if (isInitializing) { eventQueue.push({ type: 'detached', data: { tabId, detachInfo } }); return; }
  onTabDetached(tabId, detachInfo);
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  if (isInitializing) { eventQueue.push({ type: 'replaced', data: { addedTabId, removedTabId } }); return; }
  onTabReplaced(addedTabId, removedTabId);
});

chrome.tabs.onMoved.addListener(() => {
  notifySidepanel('TAB_MOVED', {});
});

// --- Group Listeners ---
chrome.tabGroups.onCreated.addListener(group => {
  groupMap.set(group.id, group);
  notifySidepanel('GROUP_CREATED', { group });
});

chrome.tabGroups.onUpdated.addListener(group => {
  groupMap.set(group.id, group);
  notifySidepanel('GROUP_UPDATED', { group });
});

chrome.tabGroups.onRemoved.addListener(groupId => {
  groupMap.delete(groupId);
  notifySidepanel('GROUP_REMOVED', { groupId });
});


// --- Handler Logic ---

async function onTabCreated(tab) {
  console.log('Tab Created:', tab.id, 'Opener:', tab.openerTabId, 'Index:', tab.index);

  // Retrieve previous tab for context (using Chrome API for fresh state)
  let prevNode = null;
  if (tab.index > 0) {
    try {
      const result = await chrome.tabs.query({ windowId: tab.windowId, index: tab.index - 1 });
      if (result && result.length > 0 && tabTree.has(result[0].id)) {
        prevNode = tabTree.get(result[0].id);
      }
    } catch (e) { console.error('Error finding prev tab:', e); }
  }

  const parentId = determineParentId(tab, tabTree, prevNode);

  tabTree.set(tab.id, {
    tabId: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    openerTabId: tab.openerTabId,
    parentId: parentId,
    children: [],
    title: tab.title || 'New Tab',
    url: tab.url || '',
    favIconUrl: tab.favIconUrl || '',
    active: tab.active,
    groupId: tab.groupId,
    level: 0
  });

  if (parentId) {
    const parent = tabTree.get(parentId);
    if (parent) {
      if (!parent.children.includes(tab.id)) {
        parent.children.push(tab.id);
      }
    }
  }

  saveTree();
  notifySidepanel('TAB_CREATED', { tab });
}

function onTabRemoved(tabId) {
  const node = tabTree.get(tabId);
  if (node) {
    if (node.parentId) {
      const parent = tabTree.get(node.parentId);
      if (parent) {
        parent.children = parent.children.filter(id => Number(id) !== Number(tabId));
      }
    }
    // Re-parent children to grand-parent (or root)
    node.children.forEach(childId => {
      const child = tabTree.get(childId);
      if (child) {
        child.parentId = node.parentId;
        if (node.parentId) {
          const parent = tabTree.get(node.parentId);
          if (parent) parent.children.push(childId);
        }
      }
    });
    tabTree.delete(tabId);
    saveTree();
  }
  notifySidepanel('TAB_REMOVED', { tabId });
}

function onTabUpdated(tabId, changeInfo, tab) {
  const node = tabTree.get(tabId);
  if (node) {
    if (changeInfo.title) node.title = changeInfo.title;
    if (changeInfo.url) node.url = changeInfo.url;
    if (changeInfo.favIconUrl) node.favIconUrl = changeInfo.favIconUrl;
    if (changeInfo.groupId !== undefined) node.groupId = changeInfo.groupId; // Handle Move to/from Group
    saveTree();
    notifySidepanel('TAB_UPDATED', { tabId, changeInfo, tab });
  }
}

function onTabActivated(activeInfo) {
  tabTree.forEach(node => {
    node.active = node.tabId === activeInfo.tabId;
  });
  notifySidepanel('TAB_ACTIVATED', { tabId: activeInfo.tabId });
}

function onTabAttached(tabId, attachInfo) {
  const node = tabTree.get(tabId);
  if (node) {
    node.windowId = attachInfo.newWindowId;
    node.parentId = null;
    node.level = 0;
    saveTree();
    notifySidepanel('TAB_MOVED', {});
  }
}

function onTabDetached(tabId, detachInfo) {
  notifySidepanel('TAB_MOVED', {});
}

function onTabReplaced(addedTabId, removedTabId) {
  const node = tabTree.get(removedTabId);
  if (node) {
    tabTree.set(addedTabId, { ...node, tabId: addedTabId });
    tabTree.delete(removedTabId);
    saveTree();
    notifySidepanel('TAB_UPDATED', { tabId: addedTabId });
  }
}


// --- Messaging ---

// This notifySidepanel function is duplicated. Keeping the one that uses sendMessage.
// The original instruction had two notifySidepanel functions. I'm assuming the one using sendMessage is the desired one.
// The provided snippet also only includes the sendMessage version.
async function notifySidepanel(type, data) {
  try {
    await chrome.runtime.sendMessage({ type, ...data });
  } catch (e) {
    // Ignore errors if no one is listening (e.g. sidepanel closed)
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle async logic inside a separate async scope, 
  // but return true immediately to keep channel open
  (async () => {
    if (message.type === 'GET_TREE') {
      // CRITICAL: Wait for initialization to complete before returning tree
      if (isInitializing && initializationPromise) {
        await initializationPromise;
      }
      sendResponse({ tree: buildTreeStructure() });
    } else if (message.type === 'UPDATE_TREE') {
      updateTreeFromStructure(message.tree);
      sendResponse({ success: true });
    } else if (message.type === 'CLOSE_TAB') {
      chrome.tabs.remove(message.tabId);
      sendResponse({ success: true });
    } else if (message.type === 'ACTIVATE_TAB') {
      chrome.tabs.update(message.tabId, { active: true });
      sendResponse({ success: true });
    }
  })();
  return true; // Keep channel open for async response
});

function updateTreeFromStructure(nodes, parentId = null, level = 0) {
  nodes.forEach(node => {
    const tabId = parseInt(node.key);
    const existing = tabTree.get(tabId);
    if (existing) {
      existing.parentId = parentId;
      existing.level = level;
      existing.children = node.children ? node.children.map(c => parseInt(c.key)) : [];
    }
    if (node.children && node.children.length > 0) {
      updateTreeFromStructure(node.children, tabId, level + 1);
    }
  });
  saveTree();
}

function saveTree() {
  const treeObj = {};
  tabTree.forEach((node, id) => {
    treeObj[id] = node;
  });
  chrome.storage.local.set({ tabTree: treeObj });
}

function buildTreeStructure() {
  const roots = [];
  const nodeMap = new Map(); // Tab Nodes
  const groupNodeMap = new Map(); // Group Nodes

  // 1. Create Nodes for Groups
  groupMap.forEach(group => {
    // We prefix key with 'group_' to distinguish from tab IDs
    const groupKey = `group_${group.id}`;
    // Map Chrome colors to known CSS classes or data attributes
    const groupNode = {
      key: groupKey,
      title: group.title || 'Untitled Group',
      folder: true,
      expanded: !group.collapsed,
      children: [],
      icon: 'waiting', // The frontend 'enhanceTitle' will handle component rendering based on data.isGroup
      data: {
        groupId: group.id,
        windowId: group.windowId,
        color: group.color, // "blue", "red", etc.
        isGroup: true
      }
    };
    groupNodeMap.set(group.id, groupNode);
  });

  // 2. Create Nodes for Tabs
  tabTree.forEach((node, id) => {
    nodeMap.set(id, {
      key: String(id),
      title: node.title,
      expanded: true,
      children: [],
      data: {
        tabId: node.tabId,
        windowId: node.windowId,
        url: node.url,
        active: node.active,
        favIconUrl: node.favIconUrl,
        groupId: node.groupId // Ensure this is passed
      }
    });
  });

  // 3. Assemble Tree
  tabTree.forEach((node, id) => {
    const treeNode = nodeMap.get(id);

    // Logic: Nesting (custom) > Grouping (native) > Root
    if (node.parentId && nodeMap.has(node.parentId)) {
      // Child of another tab -> Stay nested (Hybrid Model)
      nodeMap.get(node.parentId).children.push(treeNode);
    } else if (node.groupId > -1 && groupNodeMap.has(node.groupId)) {
      // Child of a Group -> Go into Group Folder
      groupNodeMap.get(node.groupId).children.push(treeNode);
    } else {
      // Root Tab
      roots.push(treeNode);
    }
  });

  // 4. Sort helper: Sort children by tab ID descending (newest first)
  const sortByNewest = (arr) => {
    arr.sort((a, b) => {
      // Groups don't have tabId, use groupId (keep groups at top, sorted by creation)
      const aId = a.data.tabId || 0;
      const bId = b.data.tabId || 0;
      return bId - aId; // Descending (higher ID = newer = first)
    });
    // Recursively sort children
    arr.forEach(node => {
      if (node.children && node.children.length > 0) {
        sortByNewest(node.children);
      }
    });
  };

  // 5. Combine Groups and Roots
  // Filter out empty groups (no children = group was closed or is stale)
  const groupNodes = Array.from(groupNodeMap.values()).filter(g => g.children.length > 0);

  // Sort group children (tabs inside groups) by newest first
  groupNodes.forEach(g => sortByNewest(g.children));

  // Sort groups themselves by creation (groupId ascending - older groups first, or you can reverse)
  groupNodes.sort((a, b) => a.data.groupId - b.data.groupId);

  // Sort root tabs by newest first
  sortByNewest(roots);

  return [...groupNodes, ...roots];
}
