// Global state (in-memory)
const tabTree = new Map();
let isInitializing = false;
let initializationPromise = null;
const eventQueue = [];

// Initialize immediately on load (handles Service Worker wakeups)
initializationPromise = initializeTree();

chrome.runtime.onInstalled.addListener(() => {
  initializationPromise = initializeTree();
});

chrome.runtime.onStartup.addListener(() => {
  initializationPromise = initializeTree();
});

async function initializeTree() {
  if (isInitializing) return initializationPromise;
  isInitializing = true;
  eventQueue.length = 0; // Clear queue

  try {
    // Query ALL tabs (safest for syncing state across all windows)
    const tabs = await chrome.tabs.query({});
    const stored = await chrome.storage.local.get('tabTree');
    const storedTree = stored.tabTree || {};

    // Clear and rebuild to ensure we never have stale memory state
    tabTree.clear();

    tabs.forEach(tab => {
      // We use the stored parent/children info if available, but trust the LIVE tab data
      const existing = storedTree[tab.id];
      tabTree.set(tab.id, {
        tabId: tab.id,
        windowId: tab.windowId,
        parentId: existing?.parentId || null,
        children: existing?.children || [],
        title: tab.title,
        url: tab.url,
        favIconUrl: tab.favIconUrl,
        active: tab.active,
        level: existing?.level || 0
      });
    });

    // Cleanup: Remove children pointers to IDs that don't exist in live tabs
    // This is auto-maintenance for the tree structure
    tabTree.forEach(node => {
      node.children = node.children.filter(childId => tabTree.has(childId));
    });

    saveTree();
  } finally {
    isInitializing = false;
    // Replay all buffered events that happened during the await
    // This ensures no 'created' or 'removed' events are lost
    if (eventQueue.length > 0) {
      console.log('Replaying buffered events:', eventQueue.length);
      for (const event of eventQueue) {
        await handleBufferedEvent(event);
      }
      eventQueue.length = 0;
    }
  }
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


// --- Handler Logic ---

function onTabCreated(tab) {
  tabTree.set(tab.id, {
    tabId: tab.id,
    windowId: tab.windowId,
    parentId: null,
    children: [],
    title: tab.title || 'New Tab',
    url: tab.url || '',
    favIconUrl: tab.favIconUrl || '',
    active: tab.active,
    level: 0
  });
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
