const tabTree = new Map();

chrome.runtime.onInstalled.addListener(() => {
  initializeTree();
});

chrome.runtime.onStartup.addListener(() => {
  initializeTree();
});

async function initializeTree() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const stored = await chrome.storage.local.get('tabTree');
  const storedTree = stored.tabTree || {};

  tabs.forEach(tab => {
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

chrome.tabs.onCreated.addListener(tab => {
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
});

chrome.tabs.onRemoved.addListener(tabId => {
  const node = tabTree.get(tabId);
  if (node) {
    if (node.parentId) {
      const parent = tabTree.get(node.parentId);
      if (parent) {
        parent.children = parent.children.filter(id => id !== tabId);
      }
    }
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
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const node = tabTree.get(tabId);
  if (node) {
    if (changeInfo.title) node.title = changeInfo.title;
    if (changeInfo.url) node.url = changeInfo.url;
    if (changeInfo.favIconUrl) node.favIconUrl = changeInfo.favIconUrl;
    saveTree();
    notifySidepanel('TAB_UPDATED', { tabId, changeInfo, tab });
  }
});

chrome.tabs.onActivated.addListener(activeInfo => {
  tabTree.forEach(node => {
    node.active = node.tabId === activeInfo.tabId;
  });
  notifySidepanel('TAB_ACTIVATED', { tabId: activeInfo.tabId });
});

chrome.tabs.onMoved.addListener(() => {
  notifySidepanel('TAB_MOVED', {});
});

async function notifySidepanel(type, data) {
  try {
    const views = chrome.extension.getViews({ type: 'side_panel' });
    views.forEach(view => {
      if (view.handleBackgroundMessage) {
        view.handleBackgroundMessage({ type, ...data });
      }
    });
  } catch (e) {}
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_TREE') {
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
  return true;
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
