import {
  buildParentTempMap,
  computeRestoreAssignments,
  dedupeSavedGroup,
  capSavedGroups,
} from './lib/tree-logic.mjs';

// Set to true to enable verbose per-event logging during development.
const DEBUG = false;
const log = (...args) => { if (DEBUG) console.log(...args); };

// Global state (in-memory)
const tabTree = new Map();
const groupMap = new Map(); // Store Chrome Tab Groups
let isInitializing = false;
let initializationPromise = null;
const eventQueue = [];

// --- Saved Groups (v1.2.0) ---
const SAVED_GROUPS_LIMIT = 50;
// Continuously-refreshed mirror of each live group's tabs + intra-group tree edges.
// Persisted so it survives service-worker termination (see refreshGroupSnapshot).
const snapshotDebounceTimers = new Map(); // groupId -> timeout id

// Serializes read-modify-write of saved-groups storage keys (storage.local get→set isn't atomic).
let savedGroupsChain = Promise.resolve();
function savedGroupsWrite(fn) {
  const run = savedGroupsChain.then(fn, fn);
  savedGroupsChain = run.catch(() => {});
  return run;
}

// Initialize immediately on load (handles Service Worker wakeups)
initializationPromise = initializeTree();

// Allow opening the side panel by clicking the extension icon
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('Error setting panel behavior:', error));

async function initializeTree() {
  log('Initializing Tree...');
  DEBUG && console.time('Init:Total');
  if (isInitializing) return initializationPromise;
  isInitializing = true;
  eventQueue.length = 0; // Clear queue

  try {
    // Queries in parallel
    DEBUG && console.time('Init:Query');
    const [tabs, groups] = await Promise.all([
      chrome.tabs.query({}),
      chrome.tabGroups.query({})
    ]);
    DEBUG && console.timeEnd('Init:Query');

    // Populate Group Map
    groupMap.clear();
    groups.forEach(g => groupMap.set(g.id, g));


    // Sort tabs by window and index to ensure logical processing order
    tabs.sort((a, b) => {
      if (a.windowId !== b.windowId) return a.windowId - b.windowId;
      return a.index - b.index;
    });

    DEBUG && console.time('Init:Storage');
    const stored = await chrome.storage.local.get('tabTree');
    DEBUG && console.timeEnd('Init:Storage');
    const storedTree = stored.tabTree || {};

    // Clear and rebuild to ensure we never have stale memory state
    tabTree.clear();

    // Iterate sorted tabs to build tree
    // PASS 1: Create Nodes (Restore state if available)
    DEBUG && console.time('Init:Pass1');
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      let parentId = null;
      let title = tab.title;

      // Try to recover state from storage
      if (storedTree[tab.id]) {
        // We persist valid parentId from storage to preserve structure
        // But we must validity check it later (or let the 2nd pass handle it)
        parentId = storedTree[tab.id].parentId;
      } else {
        // Fallback for new/unknown tabs active during startup
        // Optimization: Use sorted order to pass potential previous sibling
        const prevSiblingCandidate = (i > 0 && tabs[i - 1].windowId === tab.windowId) ? tabTree.get(tabs[i - 1].id) : null;
        parentId = determineParentId(tab, tabTree, prevSiblingCandidate);
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
        audible: tab.audible || false, // Track audio playing state
        muted: tab.mutedInfo?.muted || false, // Track muted state
        level: 0
      });
    }
    DEBUG && console.timeEnd('Init:Pass1');

    // PASS 2: Link Children (Robust against index order mismatch)
    tabTree.forEach(node => {
      // Validate Parent
      if (node.parentId && tabTree.has(node.parentId)) {
        const parent = tabTree.get(node.parentId);
        parent.children.push(node.tabId);
      } else {
        // If parent doesn't exist (closed?), it becomes a root
        node.parentId = null;
        node.level = 0;
      }
    });

    // Final cleanup: Ensure no stale entries made it through
    await cleanupStaleTabsFromTree();

    // Warm the saved-groups mirror for every existing group after a SW wake,
    // so their tabs+tree edges are persisted before any future removal.
    groups.forEach(g => refreshGroupSnapshot(g.id));
  } finally {
    // Drain via shift (not a fixed-length loop + length=0) so events that arrive
    // *during* replay are processed too, not discarded. The loop exits only when the
    // queue is empty, and there's no await before isInitializing is cleared, so no
    // listener can enqueue an event that then gets dropped.
    if (eventQueue.length > 0) log('Replaying buffered events:', eventQueue.length);
    while (eventQueue.length > 0) {
      await handleBufferedEvent(eventQueue.shift());
    }
    DEBUG && console.timeEnd('Init:Total');
    isInitializing = false;
  }
}

function determineParentId(tab, currentTree, prevNodeOverride = null) {
  log('--- determineParentId DEBUG ---');
  log('Tab ID:', tab.id, '| Opener Tab ID:', tab.openerTabId, '| Type:', typeof tab.openerTabId);
  log('Group ID:', tab.groupId, '| Type:', typeof tab.groupId);
  
  if (!currentTree) {
    log('DECISION: null (no currentTree)');
    return null;
  }

  const url = tab.url || '';
  const pendingUrl = tab.pendingUrl || '';
  const openerTabId = tab.openerTabId;
  
  log('URL:', tab.url, '| Pending URL:', tab.pendingUrl);
  
  // PRIORITY 0: Tab belongs to a group - NEVER nest it (HIGHEST PRIORITY)
  // Groups take precedence over parent-child relationships
  // This handles restored saved groups that have openerTabId set
  if (tab.groupId !== undefined && tab.groupId !== null && tab.groupId > -1) {
    log('DECISION: null (tab belongs to group', tab.groupId, '- groups take precedence over nesting)');
    return null;
  }
  
  // PRIORITY 1: Explicit New Tab Check
  // User explicitly opened a new tab (Ctrl+T / Cmd+T) - should ALWAYS be root
  // Chrome sets pendingUrl to 'chrome://newtab/' for explicit new tab actions
  if (url === 'chrome://newtab/' || pendingUrl === 'chrome://newtab/' ||
      url === 'about:blank' || pendingUrl === 'about:blank') {
    log('DECISION: null (explicit new tab - chrome://newtab/ or about:blank)');
    return null;
  }

  // PRIORITY 2: Check opener (for links with empty URLs)
  // Tabs opened from links have openerTabId but empty URL/pendingUrl during onCreated
  // This catches links before URL loads
  if (openerTabId && currentTree.has(openerTabId)) {
    log('DECISION:', openerTabId, '(opener exists - link clicked)');
    return openerTabId;
  }

  // PRIORITY 3: Fallback for truly empty tabs without opener
  // If we reach here with empty URLs and no opener, treat as root
  if (url === '' && pendingUrl === '') {
    log('DECISION: null (empty URLs, no valid opener)');
    return null;
  }

  let prevNode = prevNodeOverride;
  log('prevNodeOverride provided?', !!prevNodeOverride);

  // If prevNode not provided, try to find it in currentTree (O(N) lookup but acceptable for init)
  if (!prevNode) {
    for (const [id, node] of currentTree) {
      if (node.windowId === tab.windowId && node.index === tab.index - 1) {
        prevNode = node;
        break;
      }
    }
    log('prevNode found via iteration?', !!prevNode, prevNode ? `(tabId: ${prevNode.tabId})` : '');
  }

  // PRIORITY 4: Advanced logic with prevNode patterns
  if (prevNode) {
    log('prevNode info - tabId:', prevNode.tabId, '| openerTabId:', prevNode.openerTabId, '| parentId:', prevNode.parentId);
    
    // Case 2: Prev node IS the opener -> Nest under it
    if (openerTabId && prevNode.tabId === openerTabId) {
      log('DECISION:', prevNode.tabId, '(prevNode IS the opener)');
      return prevNode.tabId;
    }
    // Case 3: Prev node SHARES the same opener -> Sibling (same parent)
    if (openerTabId && prevNode.openerTabId === openerTabId) {
      log('DECISION:', prevNode.parentId, '(sibling - shares same opener)');
      return prevNode.parentId;
    }
    log('DECISION: null (prevNode exists but no matching condition)');
  } else {
    log('DECISION: null (no prevNode, no valid opener)');
  }

  return null;
}

async function handleBufferedEvent(event) {
  // Dispatch buffered events to appropriate handler functions
  switch (event.type) {
    case 'created': onTabCreated(event.data); break;
    case 'removed': onTabRemoved(event.data); break;
    case 'updated': onTabUpdated(event.data.tabId, event.data.changeInfo, event.data.tab); break;
    case 'activated': onTabActivated(event.data); break;
    case 'attached': onTabAttached(event.data.tabId, event.data.attachInfo); break;
    case 'detached': onTabDetached(event.data.tabId, event.data.detachInfo); break;
    case 'replaced': onTabReplaced(event.data.addedTabId, event.data.removedTabId); break;
    case 'groupCreated': onGroupUpsert(event.data, 'GROUP_CREATED'); break;
    case 'groupUpdated': onGroupUpsert(event.data, 'GROUP_UPDATED'); break;
  }
}

async function cleanupStaleTabsFromTree() {
  try {
    // Get all currently open tabs
    const currentTabs = await chrome.tabs.query({});
    const validTabIds = new Set(currentTabs.map(t => t.id));
    
    // Track if we removed anything
    let removedCount = 0;
    
    // Remove any tab entries that don't exist in Chrome anymore
    for (const [tabId, node] of tabTree.entries()) {
      if (!validTabIds.has(tabId)) {
        log('Removing stale tab from tree:', tabId, node.title);
        
        // Remove from parent's children array if it has a parent
        if (node.parentId && tabTree.has(node.parentId)) {
          const parent = tabTree.get(node.parentId);
          parent.children = parent.children.filter(id => id !== tabId);
        }
        
        // Re-parent children to the grandparent (matching onTabRemoved), not root,
        // so a stale middle tab doesn't collapse a whole nesting level.
        if (node.children && node.children.length > 0) {
          node.children.forEach(childId => {
            const child = tabTree.get(childId);
            if (child) {
              child.parentId = node.parentId;
              if (node.parentId) {
                const grandparent = tabTree.get(node.parentId);
                if (grandparent) grandparent.children.push(childId);
              }
            }
          });
        }

        tabTree.delete(tabId);
        removedCount++;
      }
    }
    
    // Only save if we actually removed something
    if (removedCount > 0) {
      log(`Cleaned up ${removedCount} stale tab(s) from tree`);
      saveTree();
    }
  } catch (error) {
    console.error('Error during stale tab cleanup:', error);
  }
}

// --- Saved Groups: snapshot mirror, capture, restore ---

// Refresh the persisted mirror for a single group (debounced per group).
// Reads the group's tabs + their tree edges NOW, so that when the group is later
// removed (possibly after the SW slept) we still have the data in storage.
function refreshGroupSnapshot(groupId) {
  if (groupId === undefined || groupId === null || groupId < 0) return;
  if (snapshotDebounceTimers.has(groupId)) {
    clearTimeout(snapshotDebounceTimers.get(groupId));
  }
  snapshotDebounceTimers.set(groupId, setTimeout(() => {
    snapshotDebounceTimers.delete(groupId);
    doRefreshGroupSnapshot(groupId);
  }, 300));
}

async function doRefreshGroupSnapshot(groupId) {
  try {
    const [tabs, group] = await Promise.all([
      chrome.tabs.query({ groupId }),
      chrome.tabGroups.get(groupId).catch(() => groupMap.get(groupId)),
    ]);
    if (!group || !tabs || tabs.length === 0) return;

    // Preserve Chrome's tab order within the group
    tabs.sort((a, b) => a.index - b.index);
    const snapTabs = buildParentTempMap(
      tabs.map(t => ({ id: t.id, title: t.title, url: t.url })),
      tabTree
    );

    await savedGroupsWrite(async () => {
      const { liveGroupSnapshots = {} } = await chrome.storage.local.get('liveGroupSnapshots');
      liveGroupSnapshots[groupId] = {
        name: group.title || '',
        color: group.color,
        windowId: group.windowId,
        updated: Date.now(),
        tabs: snapTabs,
      };
      await chrome.storage.local.set({ liveGroupSnapshots });
    });
  } catch (e) {
    console.error('refreshGroupSnapshot failed for', groupId, e);
  }
}

// Move a group's live snapshot into the persisted savedGroups list (on removal).
async function saveGroupSnapshot(groupId) {
  try {
    let didSave = false;
    await savedGroupsWrite(async () => {
      const { liveGroupSnapshots = {}, savedGroups = [] } =
        await chrome.storage.local.get(['liveGroupSnapshots', 'savedGroups']);

      const live = liveGroupSnapshots[groupId];
      if (!live || !live.tabs || live.tabs.length === 0) return; // nothing worth saving

      const now = Date.now();
      const snap = {
        id: `${now}-${groupId}`,
        name: live.name,
        color: live.color,
        created: now,
        lastUsed: now,
        tabs: live.tabs.map(t => ({ title: t.title, url: t.url, tempId: t.tempId, parentTempId: t.parentTempId })),
      };

      let saved = dedupeSavedGroup(savedGroups, snap);
      saved = capSavedGroups(saved, SAVED_GROUPS_LIMIT);

      delete liveGroupSnapshots[groupId];
      await chrome.storage.local.set({ savedGroups: saved, liveGroupSnapshots });
      didSave = true;
    });
    if (didSave) notifySidepanel('SAVED_GROUPS_UPDATED', {});
  } catch (e) {
    console.error('saveGroupSnapshot failed for', groupId, e);
  }
}

// Restore a saved group: reopen tabs, group them, then re-apply the captured tree edges.
async function restoreSavedGroup(savedGroupId) {
  const { savedGroups = [] } = await chrome.storage.local.get('savedGroups');
  const entry = savedGroups.find(g => g.id === savedGroupId);
  if (!entry) return;

  const tempIdToNewTabId = new Map();
  const createdIds = [];
  for (const t of entry.tabs) {
    try {
      const created = await chrome.tabs.create({ url: t.url, active: false });
      tempIdToNewTabId.set(t.tempId, created.id);
      createdIds.push(created.id);
    } catch (e) {
      console.error('restore: failed to open', t.url, e);
    }
  }
  if (createdIds.length === 0) return;

  const groupId = await chrome.tabs.group({ tabIds: createdIds });
  await chrome.tabGroups.update(groupId, { title: entry.name, color: entry.color });

  // Eagerly set groupId so onTabUpdated's same-group check sees a consistent state
  createdIds.forEach(id => { const n = tabTree.get(id); if (n) n.groupId = groupId; });
  applyTreeEdges(computeRestoreAssignments(entry.tabs, tempIdToNewTabId));

  // Bump lastUsed under the lock to avoid clobbering concurrent changes
  await savedGroupsWrite(async () => {
    const { savedGroups: current = [] } = await chrome.storage.local.get('savedGroups');
    const target = current.find(g => g.id === savedGroupId);
    if (target) {
      target.lastUsed = Date.now();
      await chrome.storage.local.set({ savedGroups: current });
    }
  });

  saveTree();
  notifySidepanel('TAB_MOVED', {});
  notifySidepanel('SAVED_GROUPS_UPDATED', {});
}

// Re-establish parentId/children edges in tabTree from a list of {tabId, parentId}.
function applyTreeEdges(assignments) {
  assignments.forEach(({ tabId, parentId }) => linkTreeEdge(tabId, parentId));
  saveTree();
}

// True if making `parentId` the parent of `tabId` would form a cycle. Loop bound by
// tree size so a pre-existing cycle can't hang it.
function wouldCreateCycle(tabId, parentId) {
  let cursor = parentId;
  let hops = 0;
  while (cursor != null && hops++ <= tabTree.size) {
    if (cursor === tabId) return true;
    const node = tabTree.get(cursor);
    cursor = node ? node.parentId : null;
  }
  return false;
}

function linkTreeEdge(tabId, parentId) {
  const node = tabTree.get(tabId);
  if (!node) return;

  if (node.parentId != null && tabTree.has(node.parentId)) {
    const old = tabTree.get(node.parentId);
    old.children = old.children.filter(id => id !== tabId);
  }

  node.parentId = parentId;
  if (parentId != null && tabTree.has(parentId)) {
    const parent = tabTree.get(parentId);
    if (!parent.children.includes(tabId)) parent.children.push(tabId);
  }
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
// onCreated/onUpdated are init-buffered: a group event arriving during init's awaits
// would otherwise be clobbered by groupMap.clear(), dropping the group until a later
// event. onRemoved is deliberately NOT buffered (see note below).
chrome.tabGroups.onCreated.addListener(group => {
  if (isInitializing) { eventQueue.push({ type: 'groupCreated', data: group }); return; }
  onGroupUpsert(group, 'GROUP_CREATED');
});

chrome.tabGroups.onUpdated.addListener(group => {
  if (isInitializing) { eventQueue.push({ type: 'groupUpdated', data: group }); return; }
  onGroupUpsert(group, 'GROUP_UPDATED');
});

function onGroupUpsert(group, notifyType) {
  groupMap.set(group.id, group);
  refreshGroupSnapshot(group.id);
  notifySidepanel(notifyType, { group });
}

// onRemoved is intentionally NOT init-buffered: the persisted liveGroupSnapshots
// mirror means a removal during init still has its data in storage, so
// saveGroupSnapshot works regardless of timing.
// Chrome may pass either a groupId (older) or a group object (newer); normalize.
chrome.tabGroups.onRemoved.addListener(groupOrId => {
  const groupId = typeof groupOrId === 'object' ? groupOrId.id : groupOrId;
  groupMap.delete(groupId);
  saveGroupSnapshot(groupId);
  notifySidepanel('GROUP_REMOVED', { groupId });
});


// --- Handler Logic ---

async function onTabCreated(tab) {
  log('=== TAB CREATED DEBUG ===');
  log('Tab ID:', tab.id);
  log('Opener Tab ID:', tab.openerTabId, '| Type:', typeof tab.openerTabId);
  log('Group ID:', tab.groupId, '| Type:', typeof tab.groupId);
  log('Index:', tab.index);
  log('URL:', tab.url);
  log('Pending URL:', tab.pendingUrl);
  log('Window ID:', tab.windowId);
  log('Tree size at creation:', tabTree.size);

  // STEP 1: Add tab to tree IMMEDIATELY (synchronously)
  // This prevents race conditions with onTabUpdated events
  tabTree.set(tab.id, {
    tabId: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    openerTabId: tab.openerTabId,
    parentId: null, // Will be determined below
    children: [],
    title: tab.title || 'New Tab',
    url: tab.url || '',
    favIconUrl: tab.favIconUrl || '',
    active: tab.active,
    groupId: tab.groupId, // Initial groupId from Chrome
    audible: tab.audible || false, // Track audio playing state
    muted: tab.mutedInfo?.muted || false, // Track muted state
    level: 0
  });
  log('✅ Tab added to tabTree synchronously');

  // STEP 2: Do async operations to determine parentId
  let prevNode = null;
  if (tab.index > 0) {
    try {
      const result = await chrome.tabs.query({ windowId: tab.windowId, index: tab.index - 1 });
      if (result && result.length > 0 && tabTree.has(result[0].id)) {
        prevNode = tabTree.get(result[0].id);
      }
    } catch (e) { console.error('Error finding prev tab:', e); }
  }

  let parentId = determineParentId(tab, tabTree, prevNode);
  log('Determined parentId:', parentId);

  // STEP 3: CRITICAL - Check if groupId changed while we were doing async operations
  // If onTabUpdated fired with a groupId change, respect that and clear parent
  const currentNode = tabTree.get(tab.id);
  if (currentNode.groupId > -1) {
    log(`🎯 Tab ${tab.id} is in group ${currentNode.groupId}, clearing parentId`);
    parentId = null; // Groups take precedence over nesting
  }

  // STEP 4: Update parentId and link parent-child relationship
  currentNode.parentId = parentId;
  
  if (parentId) {
    const parent = tabTree.get(parentId);
    if (parent) {
      if (!parent.children.includes(tab.id)) {
        parent.children.push(tab.id);
        log(`🔗 Linked tab ${tab.id} as child of ${parentId}`);
      }
    }
  }

  log('Final state - parentId:', currentNode.parentId, '| groupId:', currentNode.groupId);
  log('=== END TAB CREATED DEBUG ===');

  saveTree();
  if (currentNode.groupId > -1) refreshGroupSnapshot(currentNode.groupId);
  notifySidepanel('TAB_CREATED', { tab });
}

function onTabRemoved(tabId) {
  const node = tabTree.get(tabId);
  const affectedGroupId = node ? node.groupId : -1;
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
  // Keep the group's mirror current after a member tab closes (but the group itself
  // may still exist). If the whole group is closing, onRemoved handles the capture.
  if (affectedGroupId > -1) refreshGroupSnapshot(affectedGroupId);
  notifySidepanel('TAB_REMOVED', { tabId });
}

function onTabUpdated(tabId, changeInfo, tab) {
  log(`=== TAB UPDATED DEBUG === Tab ${tabId}`);
  log('changeInfo:', JSON.stringify(changeInfo));
  
  const node = tabTree.get(tabId);
  if (node) {
    if (changeInfo.title) node.title = changeInfo.title;
    if (changeInfo.url) node.url = changeInfo.url;
    if (changeInfo.favIconUrl) node.favIconUrl = changeInfo.favIconUrl;
    if (changeInfo.audible !== undefined) node.audible = changeInfo.audible;
    if (changeInfo.mutedInfo !== undefined) node.muted = changeInfo.mutedInfo.muted;
    
    if (changeInfo.groupId !== undefined) {
      const oldGroupId = node.groupId;
      const newGroupId = changeInfo.groupId;
      node.groupId = newGroupId;

      // Keep nesting only while parent shares the same group; otherwise un-nest.
      if (newGroupId > -1) {
        const parent = node.parentId != null ? tabTree.get(node.parentId) : null;
        if (!parent || parent.groupId !== newGroupId) {
          linkTreeEdge(tabId, null);
        }
        notifySidepanel('TAB_MOVED', {});
      }

      if (oldGroupId > -1) refreshGroupSnapshot(oldGroupId);
      if (newGroupId > -1) refreshGroupSnapshot(newGroupId);
    }

    // Keep a grouped tab's mirror current when its title/url changes
    if ((changeInfo.title || changeInfo.url) && node.groupId > -1) {
      refreshGroupSnapshot(node.groupId);
    }

    saveTree();
    notifySidepanel('TAB_UPDATED', { tabId, changeInfo, tab });
  } else {
    console.warn(`⚠️ onTabUpdated called for tab ${tabId} but tab not in tabTree!`);
  }
}

function onTabActivated(activeInfo) {
  // Scope to the activated window: each window keeps its own active tab, so switching
  // tabs in one window must not clear another window's active flag.
  tabTree.forEach(node => {
    if (node.windowId === activeInfo.windowId) {
      node.active = node.tabId === activeInfo.tabId;
    }
  });
  notifySidepanel('TAB_ACTIVATED', { tabId: activeInfo.tabId });
}

function onTabAttached(tabId, attachInfo) {
  const node = tabTree.get(tabId);
  if (node) {
    // Children stay in the old window; if left nested under this tab they'd be filtered
    // out of that window's panel (parent now lives elsewhere), so promote them to root.
    node.children.forEach(childId => {
      const child = tabTree.get(childId);
      if (child) { child.parentId = null; child.level = 0; }
    });
    node.children = [];

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

    // Re-point both link directions to the new id, else children fall to root
    // (their parentId no longer resolves) and the parent lists a dead child.
    if (node.parentId != null && tabTree.has(node.parentId)) {
      const parent = tabTree.get(node.parentId);
      parent.children = parent.children.map(id => (id === removedTabId ? addedTabId : id));
    }
    node.children.forEach(childId => {
      const child = tabTree.get(childId);
      if (child) child.parentId = addedTabId;
    });

    saveTree();
    if (node.groupId > -1) refreshGroupSnapshot(node.groupId);
    notifySidepanel('TAB_UPDATED', { tabId: addedTabId });
  }
}


// --- Messaging ---

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
      // Clean up any stale tabs before building tree structure
      await cleanupStaleTabsFromTree();
      sendResponse({ tree: buildTreeStructure() });
    } else if (message.type === 'GET_BOOKMARKS') {
      const bookmarks = await chrome.bookmarks.getTree();
      sendResponse({ bookmarks: convertBookmarksToTreeFormat(bookmarks[0].children) });
    } else if (message.type === 'UPDATE_TREE') {
      updateTreeFromStructure(message.tree);
      sendResponse({ success: true });
    } else if (message.type === 'CLOSE_TAB') {
      chrome.tabs.remove(message.tabId);
      sendResponse({ success: true });
    } else if (message.type === 'ACTIVATE_TAB') {
      chrome.tabs.update(message.tabId, { active: true });
      sendResponse({ success: true });
    } else if (message.type === 'OPEN_BOOKMARK') {
      chrome.tabs.create({ url: message.url });
      sendResponse({ success: true });
    } else if (message.type === 'SET_TAB_PARENT') {
      // Set a tab's parent (used for duplicate to make it a child of original)
      const { tabId, parentId } = message;
      const node = tabTree.get(tabId);
      const parentNode = tabTree.get(parentId);

      // A cycle makes both nodes' subtree unreachable in buildTreeStructure (tabs
      // vanish from the panel while still open).
      if (node && parentNode && !wouldCreateCycle(tabId, parentId)) {
        // Remove from old parent's children if it had one
        if (node.parentId && tabTree.has(node.parentId)) {
          const oldParent = tabTree.get(node.parentId);
          oldParent.children = oldParent.children.filter(id => id !== tabId);
        }
        
        // Set new parent
        node.parentId = parentId;
        
        // Add to new parent's children
        if (!parentNode.children.includes(tabId)) {
          parentNode.children.push(tabId);
        }
        
        saveTree();
        notifySidepanel('TAB_CREATED', {}); // Trigger tree reload
      }
      sendResponse({ success: true });
    } else if (message.type === 'GET_SAVED_GROUPS') {
      const { savedGroups = [] } = await chrome.storage.local.get('savedGroups');
      sendResponse({ savedGroups });
    } else if (message.type === 'RESTORE_SAVED_GROUP') {
      await restoreSavedGroup(message.savedGroupId);
      sendResponse({ success: true });
    } else if (message.type === 'DELETE_SAVED_GROUP') {
      await savedGroupsWrite(async () => {
        const { savedGroups = [] } = await chrome.storage.local.get('savedGroups');
        const filtered = savedGroups.filter(g => g.id !== message.savedGroupId);
        await chrome.storage.local.set({ savedGroups: filtered });
      });
      notifySidepanel('SAVED_GROUPS_UPDATED', {});
      sendResponse({ success: true });
    } else if (message.type === 'RESTORE_TREE_STRUCTURE') {
      // Re-apply nesting the panel captured before grouping. Set groupId eagerly first so
      // onTabUpdated's same-group check keeps these edges regardless of event order.
      const edges = message.edges || [];
      if (message.groupId > -1) {
        edges.forEach(({ tabId }) => { const n = tabTree.get(tabId); if (n) n.groupId = message.groupId; });
      }
      applyTreeEdges(edges);
      notifySidepanel('TAB_MOVED', {});
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
        groupId: node.groupId, // Ensure this is passed
        audible: node.audible, // Pass audio state to sidepanel
        muted: node.muted // Pass muted state to sidepanel
      }
    });
  });

  // 3. Assemble Tree
  tabTree.forEach((node, id) => {
    const treeNode = nodeMap.get(id);

    // Logic: Nesting (custom) > Grouping (native) > Root
    // Nest only when child and parent share group membership; otherwise a child in a
    // different group (or ungrouped) would render inside its parent's group folder,
    // misrepresenting Chrome's membership.
    const parentNode = node.parentId != null ? tabTree.get(node.parentId) : null;
    const sharesParentGroup = parentNode && parentNode.groupId === node.groupId;
    if (node.parentId && nodeMap.has(node.parentId) && sharesParentGroup) {
      // Child of another tab -> Stay nested (Hybrid Model)
      nodeMap.get(node.parentId).children.push(treeNode);
    } else if (node.groupId !== undefined && node.groupId !== null && node.groupId > -1 && groupNodeMap.has(node.groupId)) {
      // Child of a Group -> Go into Group Folder
      log(`Tab ${id} (${node.title}) -> Group ${node.groupId} | Group exists: ${groupNodeMap.has(node.groupId)}`);
      groupNodeMap.get(node.groupId).children.push(treeNode);
    } else {
      // Root Tab
      if (node.groupId && node.groupId > -1) {
        console.warn(`Tab ${id} (${node.title}) has groupId ${node.groupId} but group not found in groupNodeMap!`);
        console.warn(`Available groups:`, Array.from(groupNodeMap.keys()));
      }
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

// Convert Chrome bookmarks to Fancytree format
function convertBookmarksToTreeFormat(bookmarkNodes) {
  const result = [];
  
  bookmarkNodes.forEach(node => {
    // Skip empty folders or system folders we don't want to show
    if (!node.title && !node.url) return;
    
    const treeNode = {
      key: `bookmark_${node.id}`,
      title: node.title || 'Untitled',
      folder: !node.url, // Folders don't have URLs
      expanded: false, // Collapsed by default for performance
      children: [],
      data: {
        isBookmark: true,
        bookmarkId: node.id,
        url: node.url,
        dateAdded: node.dateAdded
      }
    };
    
    // Recursively process children
    if (node.children && node.children.length > 0) {
      treeNode.children = convertBookmarksToTreeFormat(node.children);
    }
    
    result.push(treeNode);
  });
  
  return result;
}
