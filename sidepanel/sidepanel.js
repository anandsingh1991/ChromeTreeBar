let tree;
let lastClickedNode = null;
let selectedNodes = new Set();
const EXTENSION_ID = chrome.runtime.id; // Helper for current ID
let reloadTimer = null;

function getFaviconUrl(pageUrl, directFavIconUrl = null) {
  // Priority: Use direct favIconUrl from Chrome if available (most reliable for new tabs)
  // Fallback: Use Chrome's _favicon API (requires favicon to be cached)
  
  if (directFavIconUrl && directFavIconUrl.startsWith('http')) {
    return directFavIconUrl;
  }
  
  if (!pageUrl) {
    return ''; // or a default
  }
  
  // Use Chrome's _favicon helper (requires "favicon" permission)
  // Size: 32px is good for high DPI
  const url = new URL(`chrome-extension://${EXTENSION_ID}/_favicon/`);
  url.searchParams.append('pageUrl', pageUrl);
  url.searchParams.append('size', '32');
  return url.toString();
}

$(document).ready(() => {
  initTree();

  // Search Logic
  // Search Logic
  $('#search-input').on('input', function (e) {
    console.log('Search Input detected:', $(this).val());
    // If tree not ready, ignore
    if (!tree || !tree.fancytree('getTree')) {
      console.warn('Tree not initialized during search');
      return;
    }

    if (e.which === 27) { // Escape check still works on keyup usually, but input handles content changes
      clearSearch();
      return;
    }

    // Safety check just in case
    const treeInstance = tree.fancytree('getTree');
    if (!treeInstance) return;

    const query = $(this).val().trim();
    const count = treeInstance.count();

    if (query) {
      $('#clear-search').show();
      // Filter: match title, mode="hide"
      // Returns count of matches
      const matchCount = treeInstance.filterBranches(query);
      console.log(`Search query: "${query}", Matches: ${matchCount}`);
    } else {
      $('#clear-search').hide();
      treeInstance.clearFilter();
    }
  });

  $('#clear-search').on('click', function () {
    clearSearch();
  });

  function clearSearch() {
    $('#search-input').val('');
    $('#clear-search').hide();
    tree.fancytree('getTree').clearFilter();
  }
});

async function initTree() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_TREE' });

  tree = $('#tree').fancytree({
    extensions: ['dnd5', 'filter'],
    quicksearch: true, // Enable Type-ahead
    filter: {
      autoApply: true,   // Re-apply last filter if lazy data is loaded
      autoExpand: true, // Expand all branches that contain matches while filtered
      counter: true,     // Show a badge with number of matching children on parent
      fuzzy: false,      // Match single characters in order, e.g. 'fb' -> 'FooBar'
      hideExpandedCounter: true,  // Hide counter badge if parent is expanded
      hideExpanders: false,       // Hide expanders if all child nodes are hidden by filter
      highlight: false,  // CRITICAL: Disable highlight to prevent overwriting custom render (favicons/close btn)
      leavesOnly: false, // Match nodes that have children too
      nodata: true,      // Display a 'no data' status node if result is empty
      mode: "hide"       // Grayout unmatched nodes (default: "dimm")
    },
    source: response.tree,
    dnd5: {
      preventRecursion: true,
      preventVoidMoves: true,
      dragStart: (node, data) => {
        if (selectedNodes.size > 0 && !selectedNodes.has(node)) {
          return false;
        }
        return true;
      },
      dragEnter: (node, data) => {
        // CLEANUP: Remove from ANY other node to prevent multiple highlights
        $('.fancytree-node.forced-drop-over').removeClass('forced-drop-over');

        // Highlight current
        $(node.span).addClass('forced-drop-over');
        return ['over'];
      },
      dragOver: (node, data) => {
        const clientX = data.originalEvent.clientX; // Mouse X position
        const ROOT_ZONE_WIDTH = 60; // Wider zone (60px) for easier targeting per user request

        // Use SOURCE node to determine if this is relevant
        // If we are dragging a Nested Node (Level > 1), enable the "Un-nest" strip logic.
        // This works even if we hover over the Root parent (which sits at x=0).
        const sourceNode = data.otherNode;
        const isNestedSource = sourceNode && sourceNode.getLevel() > 1;

        if (isNestedSource && clientX < ROOT_ZONE_WIDTH) {
          // Visual feedback for Root Drop
          $('#tree').addClass('root-drop-zone-active');

          // Cleanup node highlight
          $('.fancytree-node.forced-drop-over').removeClass('forced-drop-over');

          return 'after'; // Dummy return
        }

        // Default / Fallback
        $('#tree').removeClass('root-drop-zone-active');

        // RE-FORCE highlight (and ensure exclusivity)
        if (!$(node.span).hasClass('forced-drop-over')) {
          $('.fancytree-node.forced-drop-over').removeClass('forced-drop-over'); // Double safety
          $(node.span).addClass('forced-drop-over');
        }
      },
      dragLeave: (node, data) => {
        $(node.span).removeClass('forced-drop-over');
        $('#tree').removeClass('root-drop-zone-active');
      },
      dragDrop: (node, data) => {
        const isRootDrop = $('#tree').hasClass('root-drop-zone-active');

        // Cleanup all visuals
        $('.fancytree-node.forced-drop-over').removeClass('forced-drop-over');
        $('#tree').removeClass('root-drop-zone-active');

        const nodesToMove = selectedNodes.size > 0 ? Array.from(selectedNodes) : [data.otherNode];

        // Helper: Get a node and all its descendant tabs (for grouping children too)
        const getAllTabsFromNode = (node) => {
          const tabs = [];
          if (!node.data.isGroup) {
            tabs.push({
              tabId: parseInt(node.key),
              sourceGroupId: node.data.groupId ?? -1
            });
          }
          if (node.children) {
            node.children.forEach(child => {
              tabs.push(...getAllTabsFromNode(child));
            });
          }
          return tabs;
        };

        // Get ALL tabs (including descendants) from nodes being moved
        // Capture their current groupId BEFORE any tree manipulation
        const tabsToMove = [];
        nodesToMove.forEach(n => {
          tabsToMove.push(...getAllTabsFromNode(n));
        });
        const tabIdsToMove = tabsToMove.map(t => t.tabId);

        // Check if dropping onto a group node (any hitMode on a group header = adding to group)
        const isDropOnGroup = node.data && node.data.isGroup;

        // Check if dropping onto a tab that's INSIDE a group (inherit parent's group)
        const isDropOnTabInGroup = !isDropOnGroup && node.data && node.data.groupId > -1;

        // Determine target groupId - BUT NOT if we're doing a root drop!
        let targetGroupId = null;
        if (!isRootDrop) {  // Only set target group if NOT dropping to root
          if (isDropOnGroup) {
            targetGroupId = node.data.groupId;
          } else if (isDropOnTabInGroup && data.hitMode === 'over') {
            // Dropping as child of a grouped tab - inherit its group
            targetGroupId = node.data.groupId;
          }
        }

        // Determine if we're moving OUT of a group (to root or non-group location)
        const isMovingOutOfGroup = isRootDrop || targetGroupId === null;

        nodesToMove.forEach(moveNode => {
          if (isRootDrop) {
            moveNode.moveTo(tree.fancytree('getRootNode'), 'child');
          } else if (data.hitMode === 'over') {
            moveNode.moveTo(node, 'child');
          } else if (data.hitMode === 'before') {
            moveNode.moveTo(node, 'before');
          } else if (data.hitMode === 'after') {
            moveNode.moveTo(node, 'after');
          }
        });

        // Sync with Chrome Tab Groups API
        console.log('DragDrop debug:', {
          isRootDrop,
          targetGroupId,
          isMovingOutOfGroup,
          tabsToMove
        });

        if (tabIdsToMove.length > 0) {
          if (targetGroupId !== null) {
            // Dropping INTO a group - add tabs to Chrome group
            console.log('Adding tabs to group:', targetGroupId, tabIdsToMove);
            chrome.tabs.group({ groupId: targetGroupId, tabIds: tabIdsToMove });
          } else if (isMovingOutOfGroup) {
            // Moving OUT of a group - ungroup tabs that WERE in a group
            tabsToMove.forEach(({ tabId, sourceGroupId }) => {
              console.log('Checking tab for ungroup:', tabId, 'sourceGroupId:', sourceGroupId);
              if (sourceGroupId > -1) {
                console.log('Ungrouping tab:', tabId);
                chrome.tabs.ungroup(tabId);
              }
            });
          }
        }

        clearSelection();
        saveTreeStructure();
      }
    },
    activate: (event, data) => {
      const tabId = parseInt(data.node.key);
      chrome.runtime.sendMessage({ type: 'ACTIVATE_TAB', tabId });
    },
    renderNode: (event, data) => {
      const node = data.node;
      const $span = $(node.span);

      // Row-level classes (managed here as they are on the outer span, not title)
      $span.removeClass('active-tab multi-selected');

      if (node.data.active) {
        $span.addClass('active-tab');
      }

      if (selectedNodes.has(node)) {
        $span.addClass('multi-selected');
      }
    },
    enhanceTitle: (event, data) => {
      const node = data.node;
      const $span = $(node.span);
      const $title = $span.find('.fancytree-title');

      // Clear anything Fancytree put there
      $title.empty();

      // --- GROUP RENDER ---
      if (node.data.isGroup) {
        // Map Chrome colors
        const colorMap = {
          "grey": "#5f6368", "blue": "#1a73e8", "red": "#d93025",
          "yellow": "#e37400", "green": "#188038", "pink": "#d01884",
          "purple": "#9334e6", "cyan": "#007b83", "orange": "#e25142"
        };
        const groupColor = colorMap[node.data.color] || "#5f6368";

        // Apply styles to the Node SPAN (The Header)
        $span.addClass('group-node-header');
        $span.css('--group-color', groupColor); // Pass color to CSS

        // Also apply to the Parent LI so we can style the Children Container (UL)
        if (node.li) {
          $(node.li).addClass('group-parent-li');
          $(node.li).css('--group-color', groupColor);
        }

        // Render Title (White text, card header style)
        // We use a specific container to control layout
        $title.html(`<span class="group-title-text">${node.title}</span>`);

        // Close button for group (closes all tabs in group)
        const $groupClose = $('<div class="tab-close"><span class="material-icons" style="font-size: 16px;">close</span></div>');
        $groupClose.on('click', async (e) => {
          e.stopPropagation();
          const groupId = node.data.groupId;
          const tabs = await chrome.tabs.query({ groupId });
          const tabIds = tabs.map(t => t.id);
          chrome.tabs.remove(tabIds);
        });
        $title.append($groupClose);

        // Add a "Force Expand" visual if needed, or just let standard Fancytree expander work.
        // Fancytree expander is distinct. We might want to hide it and make the whole header clickable?
        // For now, keep expander.

        return;
      }

      // --- TAB RENDER (Existing) ---
      // Create a container for content to ensure proper flex behavior
      // Priority: Use direct favIconUrl from Chrome, fallback to _favicon API
      const faviconUrl = getFaviconUrl(node.data.url, node.data.favIconUrl);
      if (faviconUrl) {
        $title.append(`<img class="tab-favicon" src="${faviconUrl}" alt="">`);
      } else {
        // Default globe/page icon styling using Material Icons
        $title.append(`<span class="material-icons tab-favicon" style="font-size: 16px; color: #5f6368; display: flex; align-items: center; justify-content: center;">public</span>`);
      }

      // Re-add the title text (we lose the highlight markup if we just use node.title, 
      // but keeping it simple for now as per user request to fix visibility)
      $title.append(`<span class="tab-title-text" title="${node.title}">${node.title}</span>`);

      // Close button with Material Icon 'close'
      const $close = $('<div class="tab-close"><span class="material-icons" style="font-size: 16px;">close</span></div>');
      $close.on('click', (e) => {
        e.stopPropagation(); // prevent row selection
        chrome.runtime.sendMessage({ type: 'CLOSE_TAB', tabId: parseInt(node.key) });
      });
      $title.append($close);
    },
    click: (event, data) => {
      const node = data.node;

      // Group Toggle Logic
      if (node.data.isGroup) {
        // Sync with Chrome's tab group collapse state
        const groupId = node.data.groupId;
        const isCurrentlyExpanded = node.isExpanded();
        chrome.tabGroups.update(groupId, { collapsed: isCurrentlyExpanded });
        // The tree will auto-reload via GROUP_UPDATED event
        node.setFocus(false); // Fix: Remove focus immediately to prevent "transparent/white" style
        return false; // Prevent default activation (and thus the purple highlight)
      }

      if (event.ctrlKey || event.metaKey) {
        toggleSelection(node);
        lastClickedNode = node;
        return false;
      } else if (event.shiftKey && lastClickedNode) {
        selectRange(lastClickedNode, node);
        return false;
      } else {
        clearSelection();
        lastClickedNode = node;
      }
    },
    beforeActivate: (event, data) => {
      // Prevent groups from being "Active" (purple)
      if (data.node.data.isGroup) {
        return false;
      }
    }
  });
}

function toggleSelection(node) {
  if (selectedNodes.has(node)) {
    selectedNodes.delete(node);
    $(node.span).removeClass('multi-selected');
  } else {
    selectedNodes.add(node);
    $(node.span).addClass('multi-selected');
  }
}

function selectRange(startNode, endNode) {
  clearSelection();
  const allNodes = tree.fancytree('getRootNode').visit((n) => n);
  const flatNodes = [];
  tree.fancytree('getRootNode').visit((n) => {
    flatNodes.push(n);
  });

  const startIdx = flatNodes.indexOf(startNode);
  const endIdx = flatNodes.indexOf(endNode);
  const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];

  for (let i = from; i <= to; i++) {
    const node = flatNodes[i];
    selectedNodes.add(node);
    $(node.span).addClass('multi-selected');
  }
}

function clearSelection() {
  selectedNodes.forEach(node => {
    $(node.span).removeClass('multi-selected');
  });
  selectedNodes.clear();
}

async function saveTreeStructure() {
  const rootNode = tree.fancytree('getRootNode');
  const treeData = rootNode.toDict(true).children;
  await chrome.runtime.sendMessage({ type: 'UPDATE_TREE', tree: treeData });
}

// Listen for broadcast messages from background.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleBackgroundMessage(message);
  // Return false (not async response)
  return false;
});

function handleBackgroundMessage(message) {
  if (message.type === 'TAB_CREATED') {
    reloadTree();
  } else if (message.type === 'TAB_REMOVED') {
    reloadTree();
  } else if (message.type === 'TAB_UPDATED') {
    updateNode(message.tabId, message.tab, message.changeInfo || {});
  } else if (message.type === 'TAB_ACTIVATED') {
    updateActiveTab(message.tabId);
  } else if (message.type === 'TAB_MOVED') {
    reloadTree();
  } else if (message.type === 'GROUP_CREATED' || message.type === 'GROUP_UPDATED' || message.type === 'GROUP_REMOVED') {
    reloadTree();
  }
}

// Queue a reload with debounce
async function reloadTree() {
  if (reloadTimer) clearTimeout(reloadTimer);

  reloadTimer = setTimeout(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_TREE' });
    const currentWindow = await chrome.windows.getCurrent();
    const currentWindowId = currentWindow.id;

    // Filter the tree to valid nodes for THIS window only
    const filteredTree = filterNodesByWindow(response.tree, currentWindowId);

    if (!tree || !tree.fancytree('getTree')) return; // Guard against race condition
    tree.fancytree('getRootNode').removeChildren();
    tree.fancytree('getRootNode').addChildren(filteredTree);
  }, 150);
}

function filterNodesByWindow(nodes, windowId) {
  return nodes.reduce((acc, node) => {
    // If the node itself belongs to this window
    if (node.data.windowId === windowId) {
      // Recursively filter children (in case of weird data, though children should match parent window)
      if (node.children) {
        node.children = filterNodesByWindow(node.children, windowId);
      }
      acc.push(node);
    } else {
      // If this node is NOT in the window, but maybe its children are? 
      // (e.g. if we allowed cross-window grouping, which we don't naturally, 
      // but if a parent was closed and children moved... logic gets complex).
      // For now, strict window filtering is safest for a "Sidebar" experience.
      // If a folder/parent is in another window, we don't show it here.
    }
    return acc;
  }, []);
}

function updateNode(tabId, tab, changeInfo = {}) {
  if (!tree || !tree.fancytree('getTree')) return; // Guard against race condition
  const node = tree.fancytree('getNodeByKey', String(tabId));
  if (node) {
    // Only update data, then force re-render correctly or update manually
    // Since title/icon might change, we DO need a full render here.
    // However, we want to ensure custom render is called.
    // If renderTitle() is what broke it, we might need to manually update the DOM elements
    // for title and icon too. 

    if (tab.title) {
      node.title = tab.title;
      $(node.span).find('.tab-title-text').text(tab.title);
      $(node.span).find('.tab-title-text').attr('title', tab.title);
    }
    
    // Update URL if changed
    if (tab.url) {
      node.data.url = tab.url;
    }
    
    // Store direct favIconUrl from Chrome when available
    if (tab.favIconUrl) {
      node.data.favIconUrl = tab.favIconUrl;
    }
    
    // Update favicon when URL changes OR when favIconUrl changes (page finished loading)
    const shouldUpdateFavicon = tab.url || changeInfo.favIconUrl || changeInfo.status === 'complete';
    
    if (shouldUpdateFavicon && node.data.url) {
      // Priority: Use direct favIconUrl from Chrome, fallback to _favicon API
      const newFaviconUrl = getFaviconUrl(node.data.url, node.data.favIconUrl);

      const $fav = $(node.span).find('.tab-favicon');
      if ($fav.is('img')) {
        // Force reload by adding cache-busting timestamp for favicon updates
        // This ensures the browser re-fetches from Chrome's favicon cache
        $fav.attr('src', newFaviconUrl);
      } else {
        // Was a span/default, replace with img
        $(node.span).find('.fancytree-title').prepend(`<img class="tab-favicon" src="${newFaviconUrl}" alt="">`);
        $fav.remove(); // remove old default
      }
    }
  }
}

function updateActiveTab(tabId) {
  if (!tree || !tree.fancytree('getTree')) return; // Guard against race condition
  tree.fancytree('getRootNode').visit((node) => {
    const isActive = parseInt(node.key) === tabId;
    node.data.active = isActive;
    if (isActive) {
      $(node.span).addClass('active-tab');
      // CRITICAL: Sync Fancytree's internal 'active' state with Chrome's active tab.
      // This moves the "Purple" highlight to the current tab, overwriting the "Blue".
      // {noEvents: true} prevents an infinite loop of activate->sendMessage->activate
      if (!node.isActive()) {
        node.setActive(true, { noEvents: true });
      }
    } else {
      $(node.span).removeClass('active-tab');
    }
  });
}
