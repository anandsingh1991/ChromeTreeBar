let tree;
let lastClickedNode = null;
let selectedNodes = new Set();
const EXTENSION_ID = chrome.runtime.id; // Helper for current ID
let reloadTimer = null;

// Cache for failed favicon URLs - prevents retrying on every render
const faviconFailureCache = new Set();

// Set by renderPinnedStrip; lets updateActiveTab tell "pinned" from "another window".
let pinnedTabIds = new Set();

function getFaviconUrl(pageUrl, directFavIconUrl = null) {
  // Do NOT prefer tab.favIconUrl here: loading a site's own icon is cross-origin, and
  // sites sending Cross-Origin-Resource-Policy: same-origin (e.g. stackoverflow.com)
  // block it outright. _favicon reads Chrome's local store, so it can't be blocked.
  if (pageUrl) {
    const url = new URL(`chrome-extension://${EXTENSION_ID}/_favicon/`);
    url.searchParams.append('pageUrl', pageUrl);
    url.searchParams.append('size', '32');
    return url.toString();
  }

  if (directFavIconUrl && directFavIconUrl.startsWith('http')) {
    return directFavIconUrl;
  }

  return '';
}

function getFirstLetterFallback(url, title) {
  // Extract first letter from domain name
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.replace(/^www\./, ''); // Strip www.
    const letter = hostname.charAt(0).toUpperCase();
    
    // Generate a color based on the domain (consistent for same domain)
    const hue = hostname.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % 360;
    const color = `hsl(${hue}, 65%, 55%)`;
    
    return { letter, color };
  } catch (e) {
    // Fallback to title if URL parsing fails
    const letter = title ? title.charAt(0).toUpperCase() : '?';
    return { letter, color: '#5f6368' };
  }
}

function createFaviconElement(node) {
  // Single unified function for creating/updating favicon elements with caching
  const faviconUrl = getFaviconUrl(node.data.url, node.data.favIconUrl);
  const cacheKey = faviconUrl || node.data.url;
  
  // Check cache BEFORE trying to load - instant letter icon for known failures
  if (faviconFailureCache.has(cacheKey)) {
    // This favicon previously failed - return letter icon immediately
    const fallback = getFirstLetterFallback(node.data.url, node.title);
    return $(`<span class="tab-favicon tab-letter-icon" style="background-color: ${fallback.color};">${fallback.letter}</span>`);
  }
  
  if (!faviconUrl) {
    // No favicon URL available - return letter icon immediately
    const fallback = getFirstLetterFallback(node.data.url, node.title);
    return $(`<span class="tab-favicon tab-letter-icon" style="background-color: ${fallback.color};">${fallback.letter}</span>`);
  }
  
  // .attr (not string interpolation) so a quote in the URL can't break out of the attribute.
  const $favicon = $('<img class="tab-favicon" alt="">').attr('src', faviconUrl);
  $favicon.on('error', function() {
    // Add to cache so we don't retry this URL
    faviconFailureCache.add(cacheKey);
    
    const fallback = getFirstLetterFallback(node.data.url, node.title);
    $(this).replaceWith(
      `<span class="tab-favicon tab-letter-icon" style="background-color: ${fallback.color};">${fallback.letter}</span>`
    );
  });
  
  return $favicon;
}

// 6-column cap keeps a pill above a comfortable click target; past that the strip wraps.
function getPinnedPillMetrics(count) {
  const perRow = Math.min(count, 6);
  return {
    perRow,
    height: perRow <= 2 ? 34 : perRow <= 4 ? 30 : 28,
    icon: perRow <= 2 ? 18 : perRow <= 4 ? 16 : 14
  };
}

// Fancytree's "No data." counts only tree matches, so a pinned-only match would show a
// pill above an empty-results message.
function syncNoDataVisibility() {
  const hasPills = document.querySelectorAll('#pinned-strip .pinned-pill').length > 0;
  // Must be a class, not inline display: the row rule uses display: flex !important.
  $('#tree .fancytree-statusnode-nodata').toggleClass('fancytree-hide', hasPills);
}

async function renderPinnedStrip() {
  const strip = document.getElementById('pinned-strip');
  if (!strip) return;

  const currentWindow = await chrome.windows.getCurrent();
  const allPinned = await chrome.tabs.query({ pinned: true, windowId: currentWindow.id });
  // Unfiltered on purpose — updateActiveTab needs every pinned id, not just matches.
  pinnedTabIds = new Set(allPinned.map(t => t.id));

  // The strip is outside the Fancytree instance, so filterBranches can't reach it.
  const query = $('#search-input').val().trim();
  const pinned = query
    ? allPinned.filter(t => matchesQuery(query, t.title, t.url))
    : allPinned;

  strip.innerHTML = '';
  if (pinned.length === 0) {
    strip.style.display = 'none';
    return;
  }

  const { perRow, height, icon } = getPinnedPillMetrics(pinned.length);
  strip.style.setProperty('--pin-per-row', perRow);
  strip.style.setProperty('--pin-h', `${height}px`);
  strip.style.setProperty('--pin-icon', `${icon}px`);
  strip.style.display = 'flex';

  pinned.forEach(tab => {
    const $pill = $('<div class="pinned-pill"></div>')
      .toggleClass('active-pin', tab.active)
      .attr('title', tab.title || tab.url)
      .data('tabId', tab.id);

    const faviconUrl = getFaviconUrl(tab.url, tab.favIconUrl);
    const cacheKey = faviconUrl || tab.url;
    const letterIcon = () => {
      const fallback = getFirstLetterFallback(tab.url, tab.title);
      return $(`<span class="pin-letter-icon" style="background-color: ${fallback.color};">${fallback.letter}</span>`);
    };

    if (!faviconUrl || faviconFailureCache.has(cacheKey)) {
      $pill.append(letterIcon());
    } else {
      // .attr (not interpolation) so a quote in the URL can't break out of the attribute.
      const $img = $('<img class="pin-favicon" alt="">').attr('src', faviconUrl);
      $img.on('error', function () {
        faviconFailureCache.add(cacheKey);
        $(this).replaceWith(letterIcon());
      });
      $pill.append($img);
    }

    strip.appendChild($pill[0]);
  });
}

// Shared by the tree filter and the pinned strip so the two can't disagree on a match.
function matchesQuery(query, title, url) {
  const needle = query.toLowerCase();
  return (title || '').toLowerCase().indexOf(needle) >= 0
    || (url || '').toLowerCase().indexOf(needle) >= 0;
}

function makeSearchMatcher(query) {
  return (node) => matchesQuery(query, node.title, node.data && node.data.url);
}

function addBookmarksToTree() {
  if (!tree || !tree.fancytree('getTree')) return;
  if (!window.bookmarksData) return;
  
  const rootNode = tree.fancytree('getTree').getRootNode();
  const hasBookmarks = rootNode.children.some(child => child.key === 'bookmarks-root');
  
  if (!hasBookmarks) {
    rootNode.addChildren({
      key: 'bookmarks-root',
      title: 'Bookmarks',
      folder: true,
      expanded: true,
      children: window.bookmarksData,
      data: { isBookmarkFolder: true },
      icon: false
    });
  }
}

function removeBookmarksFromTree() {
  if (!tree || !tree.fancytree('getTree')) return;
  
  const rootNode = tree.fancytree('getTree').getRootNode();
  const bookmarksNode = rootNode.findFirst((node) => node.key === 'bookmarks-root');
  
  if (bookmarksNode) {
    bookmarksNode.remove();
  }
}

$(document).ready(async () => {
  initTree();
  renderPinnedStrip();

  $('#pinned-strip').on('click', '.pinned-pill', function () {
    chrome.runtime.sendMessage({ type: 'ACTIVATE_TAB', tabId: $(this).data('tabId') });
  });

  $('#pinned-strip').on('contextmenu', '.pinned-pill', function (e) {
    e.preventDefault();
    showPinnedContextMenu(e, $(this).data('tabId'));
  });

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
      addBookmarksToTree();

      const matchCount = treeInstance.filterBranches(makeSearchMatcher(query));
      console.log(`Search query: "${query}", Matches: ${matchCount}`);
    } else {
      $('#clear-search').hide();
      treeInstance.clearFilter();
      removeBookmarksFromTree();
    }
    // Ordered: syncNoDataVisibility counts rendered pills.
    renderPinnedStrip().then(syncNoDataVisibility);
  });

  $('#clear-search').on('click', function () {
    clearSearch();
  });

  function clearSearch() {
    $('#search-input').val('');
    $('#clear-search').hide();
    const treeInstance = tree.fancytree('getTree');
    treeInstance.clearFilter();
    removeBookmarksFromTree();
    renderPinnedStrip();
  }
});

async function initTree() {
  console.time('🕐 TOTAL: initTree');
  
  const [tabsResponse, bookmarksResponse] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'GET_TREE' }),
    chrome.runtime.sendMessage({ type: 'GET_BOOKMARKS' })
  ]);
  
  // Store bookmarks globally for search
  window.bookmarksData = bookmarksResponse.bookmarks;

  // Get current window and filter tree to show only current window's tabs
  const currentWindow = await chrome.windows.getCurrent();
  const currentWindowId = currentWindow.id;

  // Filter the tree to valid nodes for THIS window only
  const filteredTree = filterNodesByWindow(tabsResponse.tree, currentWindowId);

  // Initially show only tabs (no bookmarks)
  const combinedTree = filteredTree;
  
  tree = $('#tree').fancytree({
    extensions: ['dnd5', 'filter'],
    quicksearch: true, // Enable Type-ahead
    // Must stay true: Fancytree's initial render writes node.title (a page's
    // document.title) as raw HTML before enhanceTitle rebuilds it, so without this
    // attacker markup in a title executes on render.
    escapeTitles: true,
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
      mode: "hide"       // Hide unmatched nodes (default: "dimm")
    },
    source: combinedTree,
    dnd5: {
      preventRecursion: true,
      preventVoidMoves: true,
      dragStart: (node, data) => {
        // Prevent dragging bookmarks
        if (node.data.isBookmark || node.data.isBookmarkFolder) {
          return false;
        }
        if (selectedNodes.size > 0 && !selectedNodes.has(node)) {
          return false;
        }
        return true;
      },
      dragEnter: (node, data) => {
        // Prevent dropping on bookmarks
        if (node.data.isBookmark || node.data.isBookmarkFolder) {
          return false;
        }
        
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
      const node = data.node;
      
      // Handle bookmark clicks - open in new tab
      if (node.data.isBookmark && node.data.url) {
        chrome.runtime.sendMessage({ type: 'OPEN_BOOKMARK', url: node.data.url });
        return;
      }
      
      // Handle tab activation
      if (!node.data.isBookmarkFolder && !node.data.isGroup) {
        const tabId = parseInt(node.key);
        chrome.runtime.sendMessage({ type: 'ACTIVATE_TAB', tabId });
      }
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

      // --- BOOKMARKS ROOT FOLDER RENDER ---
      if (node.data.isBookmarkFolder) {
        $span.addClass('bookmarks-root-header');
        
        // Bookmarks icon + title
        $title.html(`
          <span class="material-icons bookmark-icon" style="font-size: 18px; margin-right: 8px;">bookmarks</span>
          <span class="bookmark-title-text">${escapeHtml(node.title)}</span>
        `);
        return;
      }

      // --- BOOKMARK ITEM RENDER ---
      if (node.data.isBookmark) {
        $span.addClass('bookmark-node');

        // Folders keep a folder glyph; leaf bookmarks show the real site favicon
        // (with letter fallback) so rows are visually distinguishable like native.
        if (node.folder) {
          $title.append(`<span class="material-icons bookmark-icon" style="font-size: 16px;">folder</span>`);
        } else {
          $title.append(createFaviconElement(node));
        }

        $title.append(`<span class="bookmark-title-text">${escapeHtml(node.title)}</span>`);
        return;
      }

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
        $title.html(`<span class="group-title-text">${escapeHtml(node.title)}</span>`);

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

        return;
      }

      // --- TAB RENDER ---
      // Use unified favicon creation function
      $title.append(createFaviconElement(node));

      // Re-add the title text
      $title.append(`<span class="tab-title-text">${escapeHtml(node.title)}</span>`);

      // Audio indicator (rightmost position before close button)
      if (node.data.audible) {
        const audioIcon = node.data.muted ? 'volume_off' : 'volume_up';
        const $audio = $(`<span class="audio-indicator material-icons">${audioIcon}</span>`);
        $title.append($audio);
      }

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

      // Bookmarks: Don't allow multi-select, just expand/collapse folders
      if (node.data.isBookmark || node.data.isBookmarkFolder) {
        return; // Let default behavior handle folder toggle
      }

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
        // If starting a new multi-selection, include the currently active node too
        if (selectedNodes.size === 0) {
          const activeNode = tree.fancytree('getTree').getActiveNode();
          if (activeNode && activeNode !== node && !activeNode.data.isGroup) {
            toggleSelection(activeNode);
          }
        }
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
      // Prevent groups and bookmarks from being "Active" (purple)
      if (data.node.data.isGroup || data.node.data.isBookmarkFolder) {
        return false;
      }
    }
  });
  
  console.timeEnd('🕐 TOTAL: initTree');
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
  // Only visible nodes: visit() also walks filtered/collapsed nodes, so a shift-range
  // during an active search would otherwise select tabs the user can't see.
  const flatNodes = [];
  tree.fancytree('getRootNode').visit((n) => {
    if (n.isVisible()) flatNodes.push(n);
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
    renderPinnedStrip();
  } else if (message.type === 'TAB_REMOVED') {
    reloadTree();
    renderPinnedStrip();
  } else if (message.type === 'TAB_UPDATED') {
    updateNode(message.tabId, message.tab, message.changeInfo || {});
    if (message.changeInfo && (message.changeInfo.pinned !== undefined || message.changeInfo.favIconUrl || message.changeInfo.title)) {
      renderPinnedStrip();
    }
  } else if (message.type === 'TAB_ACTIVATED') {
    updateActiveTab(message.tabId);
    renderPinnedStrip();
  } else if (message.type === 'TAB_MOVED') {
    reloadTree();
    renderPinnedStrip();
  } else if (message.type === 'GROUP_CREATED' || message.type === 'GROUP_UPDATED' || message.type === 'GROUP_REMOVED') {
    reloadTree();
  } else if (message.type === 'SAVED_GROUPS_UPDATED') {
    // Re-render the saved-groups dialog if it's currently open
    if (savedGroupsDialog.classList.contains('show')) {
      renderSavedGroups();
    }
  }
}

// Queue a reload with debounce
async function reloadTree() {
  if (reloadTimer) clearTimeout(reloadTimer);

  reloadTimer = setTimeout(async () => {
    const [tabsResponse, bookmarksResponse] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_TREE' }),
      chrome.runtime.sendMessage({ type: 'GET_BOOKMARKS' })
    ]);
    
    // Store bookmarks globally
    window.bookmarksData = bookmarksResponse.bookmarks;
    
    const currentWindow = await chrome.windows.getCurrent();
    const currentWindowId = currentWindow.id;

    // Filter the tree to valid nodes for THIS window only
    const filteredTree = filterNodesByWindow(tabsResponse.tree, currentWindowId);

    if (!tree || !tree.fancytree('getTree')) return; // Guard against race condition
    
    const rootNode = tree.fancytree('getRootNode');
    const isSearching = $('#search-input').val().trim().length > 0;
    
    // Build tree with or without bookmarks based on search state
    let combinedTree = filteredTree;
    if (isSearching) {
      combinedTree = [
        ...filteredTree,
        {
          key: 'bookmarks-root',
          title: 'Bookmarks',
          folder: true,
          expanded: true,
          children: bookmarksResponse.bookmarks,
          data: { isBookmarkFolder: true },
          icon: false
        }
      ];
    }
    
    // removeChildren() below destroys these node objects; stale refs leave a ghost
    // selection that blocks dragStart for every fresh node.
    selectedNodes.clear();
    lastClickedNode = null;

    rootNode.removeChildren();
    rootNode.addChildren(combinedTree);

    // Re-apply filter if searching
    if (isSearching) {
      tree.fancytree('getTree').filterBranches(makeSearchMatcher($('#search-input').val().trim()));
    }
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
    // Update node data and manually update DOM elements for performance
    if (tab.title) {
      node.title = tab.title;
      $(node.span).find('.tab-title-text').text(tab.title);
    }
    
    // Update URL if changed
    if (tab.url) {
      node.data.url = tab.url;
    }
    
    // Store direct favIconUrl from Chrome when available
    if (tab.favIconUrl) {
      node.data.favIconUrl = tab.favIconUrl;
    }
    
    // Update audio state if changed
    if (changeInfo.audible !== undefined) {
      node.data.audible = changeInfo.audible;
    }
    if (changeInfo.mutedInfo !== undefined) {
      node.data.muted = changeInfo.mutedInfo.muted;
    }
    
    // Update audio indicator when audio state changes
    if (changeInfo.audible !== undefined || changeInfo.mutedInfo !== undefined) {
      const $title = $(node.span).find('.fancytree-title');
      const $existingAudio = $title.find('.audio-indicator');
      
      if (node.data.audible) {
        // Tab has audio - show/update indicator
        const audioIcon = node.data.muted ? 'volume_off' : 'volume_up';
        if ($existingAudio.length > 0) {
          // Update existing indicator
          $existingAudio.text(audioIcon);
        } else {
          // Add new indicator (insert before close button)
          const $audio = $(`<span class="audio-indicator material-icons">${audioIcon}</span>`);
          const $close = $title.find('.tab-close');
          if ($close.length > 0) {
            $audio.insertBefore($close);
          } else {
            $title.append($audio);
          }
        }
      } else {
        // Tab no longer has audio - remove indicator
        $existingAudio.remove();
      }
    }
    
    // Update favicon when URL changes OR when favIconUrl changes (page finished loading)
    const shouldUpdateFavicon = tab.url || changeInfo.favIconUrl || changeInfo.status === 'complete';
    
    if (shouldUpdateFavicon && node.data.url) {
      // Replace existing favicon with new one using unified function
      const $existingFav = $(node.span).find('.tab-favicon');
      const $newFav = createFaviconElement(node);
      $existingFav.replaceWith($newFav);
    }
  }
}

function updateActiveTab(tabId) {
  if (!tree || !tree.fancytree('getTree')) return; // Guard against race condition
  // Ignore activations for tabs not in this window's tree, else another window's
  // activation would clear this panel's highlight and re-add none. Pinned tabs are
  // absent from the tree by design, so they must not be filtered out here.
  if (!tree.fancytree('getNodeByKey', String(tabId)) && !pinnedTabIds.has(tabId)) return;
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

// =====================================================
// CONTEXT MENU & GROUP DIALOG FUNCTIONALITY
// =====================================================

const contextMenu = document.getElementById('context-menu');
const groupDialog = document.getElementById('group-dialog');
const groupNameInput = document.getElementById('group-name-input');

let contextMenuTarget = null; // { type: 'tab'|'group'|'multi'|'empty', node: FancytreeNode|null, nodes: FancytreeNode[] }
let pendingGroupTabIds = []; // Tab IDs to group when color is selected
let pendingGroupEdges = [];  // Captured nesting to reassert after grouping
let lastContextMenuPosition = { x: 100, y: 100 }; // Store position for dialogs
let editingGroupContext = null; // Store context when editing a group

// Close context menu and group dialog
function closeContextMenu() {
  contextMenu.classList.remove('show');
  setTimeout(() => {
    if (!contextMenu.classList.contains('show')) {
      contextMenu.style.display = 'none';
    }
  }, 100); // Match context menu transition duration
  contextMenuTarget = null;
}

function closeGroupDialog() {
  groupDialog.classList.remove('show');
  setTimeout(() => {
    if (!groupDialog.classList.contains('show')) {
      groupDialog.style.display = 'none';
    }
  }, 150); // Match group dialog transition duration
  groupNameInput.value = '';
  pendingGroupTabIds = [];
  pendingGroupEdges = [];
  document.querySelectorAll('.color-option').forEach(el => el.classList.remove('selected'));
}

// Position menu within viewport bounds
function positionElement(element, x, y) {
  // First set display to get accurate dimensions
  element.style.display = 'block';
  element.style.left = `${x}px`;
  element.style.top = `${y}px`;
  
  // Now get accurate rect with current position
  const rect = element.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  
  let finalX = x;
  let finalY = y;
  
  // Adjust if going off right edge
  if (rect.right > viewportWidth) {
    finalX = viewportWidth - rect.width - 8;
  }
  
  // Adjust if going off bottom edge
  if (rect.bottom > viewportHeight) {
    finalY = viewportHeight - rect.height - 8;
  }
  
  // Apply final position
  element.style.left = `${Math.max(8, finalX)}px`;
  element.style.top = `${Math.max(8, finalY)}px`;
  
  // Trigger animation by adding class after display is set
  setTimeout(() => element.classList.add('show'), 0);
}

// Build menu items based on context
function buildMenuItems(context) {
  const items = [];
  
  if (context.type === 'pinned') {
    items.push({ icon: 'push_pin', label: 'Unpin tab', action: 'unpin' });
    items.push({ type: 'separator' });
    items.push({ icon: 'close', label: 'Close tab', action: 'closePinned' });
    return items;
  }

  if (context.type === 'bookmark') {
    items.push({ icon: 'open_in_new', label: 'Open in new tab', action: 'openBookmark' });
    items.push({ icon: 'tab', label: 'Open in current tab', action: 'openBookmarkCurrent' });
    return items;
  } else if (context.type === 'bookmark-folder') {
    items.push({ icon: 'open_in_browser', label: 'Open all bookmarks', action: 'openAllBookmarks' });
    return items;
  }
  
  if (context.type === 'tab') {
    items.push({ icon: 'content_copy', label: 'Duplicate tab', action: 'duplicate' });
    
    // Add mute/unmute option if tab has audio
    if (context.node.data.audible) {
      const muteLabel = context.node.data.muted ? 'Unmute tab' : 'Mute tab';
      const muteIcon = context.node.data.muted ? 'volume_up' : 'volume_off';
      items.push({ type: 'separator' });
      items.push({ icon: muteIcon, label: muteLabel, action: 'toggleMute' });
    }
    
    items.push({ type: 'separator' });
    items.push({ icon: 'push_pin', label: 'Pin tab', action: 'pin' });
    items.push({ icon: 'create_new_folder', label: 'Add to new group', action: 'createGroup' });
    items.push({ type: 'separator' });
    items.push({ icon: 'close', label: 'Close tab with children', action: 'closeWithChildren' });
    items.push({ icon: 'delete_sweep', label: 'Close other tabs', action: 'closeOthers' });
  } else if (context.type === 'multi') {
    items.push({ icon: 'create_new_folder', label: `Add ${context.nodes.length} tabs to new group`, action: 'createGroup' });
    items.push({ type: 'separator' });
    items.push({ icon: 'close', label: `Close ${context.nodes.length} tabs`, action: 'close' });
    items.push({ icon: 'account_tree', label: `Close ${context.nodes.length} tabs with children`, action: 'closeWithChildren' });
  } else if (context.type === 'group') {
    items.push({ icon: 'edit', label: 'Edit group name', action: 'editGroup' });
    items.push({ icon: 'folder_off', label: 'Ungroup tabs', action: 'ungroup' });
    items.push({ type: 'separator' });
    items.push({ icon: 'close', label: 'Close group', action: 'closeGroup' });
  } else if (context.type === 'empty') {
    items.push({ icon: 'add', label: 'New tab', action: 'newTab' });
    items.push({ type: 'separator' });
    items.push({ icon: 'delete_sweep', label: 'Close all tabs', action: 'closeAll' });
  }
  
  return items;
}

// Render menu items to DOM
function renderMenuItems(items) {
  contextMenu.innerHTML = '';
  items.forEach(item => {
    if (item.type === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      contextMenu.appendChild(sep);
    } else {
      const div = document.createElement('div');
      div.className = 'context-menu-item';
      div.dataset.action = item.action;
      div.innerHTML = `<span class="material-icons">${item.icon}</span>${item.label}`;
      contextMenu.appendChild(div);
    }
  });
}

// Handle menu item click
async function handleMenuAction(action) {
  const context = contextMenuTarget;
  closeContextMenu();
  
  if (!context) return;
  
  switch (action) {
    case 'openBookmark': {
      if (context.node.data.url) {
        await chrome.runtime.sendMessage({ type: 'OPEN_BOOKMARK', url: context.node.data.url });
      }
      break;
    }
    case 'openBookmarkCurrent': {
      if (context.node.data.url) {
        const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (currentTab) {
          await chrome.tabs.update(currentTab.id, { url: context.node.data.url });
        }
      }
      break;
    }
    case 'openAllBookmarks': {
      // Recursively collect all bookmark URLs from folder
      const collectBookmarkUrls = (node) => {
        const urls = [];
        if (node.data.url) {
          urls.push(node.data.url);
        }
        if (node.children) {
          node.children.forEach(child => {
            urls.push(...collectBookmarkUrls(child));
          });
        }
        return urls;
      };
      
      const urls = collectBookmarkUrls(context.node);
      for (const url of urls) {
        await chrome.runtime.sendMessage({ type: 'OPEN_BOOKMARK', url });
      }
      break;
    }
    case 'duplicate': {
      const originalTabId = parseInt(context.node.key);
      const newTab = await chrome.tabs.duplicate(originalTabId);
      // Make the duplicate a child of the original tab
      await chrome.runtime.sendMessage({ 
        type: 'SET_TAB_PARENT', 
        tabId: newTab.id, 
        parentId: originalTabId 
      });
      break;
    }
    case 'toggleMute': {
      const tabId = parseInt(context.node.key);
      const currentMuted = context.node.data.muted;
      await chrome.tabs.update(tabId, { muted: !currentMuted });
      break;
    }
    case 'pin': {
      await chrome.tabs.update(parseInt(context.node.key), { pinned: true });
      break;
    }
    case 'unpin': {
      await chrome.tabs.update(context.tabId, { pinned: false });
      break;
    }
    case 'closePinned': {
      await chrome.tabs.remove(context.tabId);
      break;
    }
    case 'createGroup': {
      const nodes = context.type === 'multi' ? context.nodes : [context.node];
      const groupableNodes = nodes.filter(n => !n.data.isGroup);
      pendingGroupTabIds = [...new Set(groupableNodes.flatMap(collectAllTabIdsFromNode))];
      pendingGroupEdges = captureTreeEdges(groupableNodes);
      showGroupDialog(lastContextMenuPosition.x, lastContextMenuPosition.y);
      break;
    }
    case 'close': {
      const tabIds = context.type === 'multi'
        ? context.nodes.filter(n => !n.data.isGroup).map(n => parseInt(n.key))
        : [parseInt(context.node.key)];
      await chrome.tabs.remove(tabIds);
      clearSelection();
      break;
    }
    case 'closeOthers': {
      const keep = new Set(collectAllTabIdsFromNode(context.node));
      const currentWindow = await chrome.windows.getCurrent();
      const tabs = await chrome.tabs.query({ windowId: currentWindow.id });
      // Pinned tabs survive, matching Chrome's own "Close other tabs".
      const toClose = tabs.filter(t => !keep.has(t.id) && !t.pinned).map(t => t.id);
      if (toClose.length) await chrome.tabs.remove(toClose);
      clearSelection();
      break;
    }
    case 'closeWithChildren': {
      // Helper to collect all descendant tab IDs from a Fancytree node
      const collectAllTabIds = (node) => {
        const ids = [];
        if (!node.data.isGroup) {
          ids.push(parseInt(node.key));
        }
        if (node.children) {
          node.children.forEach(child => {
            ids.push(...collectAllTabIds(child));
          });
        }
        return ids;
      };
      
      const nodes = context.type === 'multi' ? context.nodes : [context.node];
      const allTabIds = [];
      nodes.forEach(n => {
        if (!n.data.isGroup) {
          allTabIds.push(...collectAllTabIds(n));
        }
      });
      
      // Remove duplicates and close all
      const uniqueTabIds = [...new Set(allTabIds)];
      if (uniqueTabIds.length > 0) {
        await chrome.tabs.remove(uniqueTabIds);
      }
      clearSelection();
      break;
    }
    case 'editGroup': {
      pendingGroupTabIds = [];
      pendingGroupEdges = [];
      const groupId = context.node.data.groupId;
      const group = await chrome.tabGroups.get(groupId);
      groupNameInput.value = group.title || '';
      editingGroupContext = context; // Store for later use in createOrUpdateGroup
      showGroupDialog(lastContextMenuPosition.x, lastContextMenuPosition.y, true, group.color);
      break;
    }
    case 'ungroup': {
      const groupId = context.node.data.groupId;
      const tabs = await chrome.tabs.query({ groupId });
      await chrome.tabs.ungroup(tabs.map(t => t.id));
      break;
    }
    case 'closeGroup': {
      const groupId = context.node.data.groupId;
      const tabs = await chrome.tabs.query({ groupId });
      await chrome.tabs.remove(tabs.map(t => t.id));
      break;
    }
    case 'newTab': {
      await chrome.tabs.create({});
      break;
    }
    case 'closeAll': {
      const currentWindow = await chrome.windows.getCurrent();
      const tabs = await chrome.tabs.query({ windowId: currentWindow.id });
      // Keep at least one tab (Chrome requires it), create a new tab first
      await chrome.tabs.create({ windowId: currentWindow.id });
      await chrome.tabs.remove(tabs.map(t => t.id));
      break;
    }
  }
}

// Show group dialog
function showGroupDialog(x, y, isEdit = false, currentColor = null) {
  closeContextMenu();
  positionElement(groupDialog, x, y);
  
  // Focus input after animation starts
  setTimeout(() => groupNameInput.focus(), 50);
  
  // If no color specified (creating new group), use smart color selection
  let selectedColor = currentColor;
  if (!selectedColor) {
    // Get colors already in use by existing groups and count total groups
    const rootNode = tree.fancytree('getRootNode');
    const rootChildren = rootNode.children || [];
    const usedColors = new Set();
    let groupCount = 0;
    rootChildren.forEach(node => {
      if (node.data.isGroup) {
        groupCount++;
        if (node.data.color) {
          usedColors.add(node.data.color);
        }
      }
    });
    
    // All available colors
    const allColors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
    
    // Filter to unused colors
    const availableColors = allColors.filter(c => !usedColors.has(c));
    
    // Use group count to rotate through available colors for consistent distribution
    const colorPalette = availableColors.length > 0 ? availableColors : allColors;
    selectedColor = colorPalette[groupCount % colorPalette.length];
    
    console.log('Group dialog: Groups:', groupCount, '| Used colors:', Array.from(usedColors), '| Selected:', selectedColor);
  }
  
  // Clear previous selection and select the appropriate color
  document.querySelectorAll('.color-option').forEach(el => el.classList.remove('selected'));
  const colorToSelect = document.querySelector(`.color-option[data-color="${selectedColor}"]`);
  if (colorToSelect) {
    colorToSelect.classList.add('selected');
  }
}

// Create or update group when color is clicked
async function createOrUpdateGroup(color) {
  const name = groupNameInput.value.trim();
  
  if (pendingGroupTabIds.length > 0) {
    // Creating new group
    const edges = pendingGroupEdges;
    const groupId = await chrome.tabs.group({ tabIds: pendingGroupTabIds });
    await chrome.tabGroups.update(groupId, { title: name, color });
    await chrome.runtime.sendMessage({ type: 'RESTORE_TREE_STRUCTURE', edges, groupId });
  } else if (editingGroupContext && editingGroupContext.type === 'group') {
    // Editing existing group
    const groupId = editingGroupContext.node.data.groupId;
    await chrome.tabGroups.update(groupId, { title: name, color });
  }
  
  closeGroupDialog();
  editingGroupContext = null; // Clear after use
}

function showPinnedContextMenu(e, tabId) {
  closeGroupDialog();
  lastContextMenuPosition = { x: e.clientX, y: e.clientY };
  contextMenuTarget = { type: 'pinned', node: null, nodes: [], tabId };
  renderMenuItems(buildMenuItems(contextMenuTarget));
  positionElement(contextMenu, e.clientX, e.clientY);
}

// Context menu event listener
document.getElementById('tree').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  closeGroupDialog();
  
  // Store position for later use in dialogs
  lastContextMenuPosition = { x: e.clientX, y: e.clientY };
  
  // Find the clicked node
  const $node = $(e.target).closest('.fancytree-node');
  let context;
  
  if ($node.length > 0) {
    const node = $.ui.fancytree.getNode($node[0]);
    
    if (node.data.isBookmark && !node.folder) {
      context = { type: 'bookmark', node, nodes: [node] };
    } else if (node.data.isBookmark && node.folder) {
      context = { type: 'bookmark-folder', node, nodes: [node] };
    } else if (node.data.isBookmarkFolder) {
      context = { type: 'bookmark-folder', node, nodes: [node] };
    } else if (node.data.isGroup) {
      context = { type: 'group', node, nodes: [node] };
    } else if (selectedNodes.size > 1 && selectedNodes.has(node)) {
      context = { type: 'multi', node, nodes: Array.from(selectedNodes) };
    } else {
      context = { type: 'tab', node, nodes: [node] };
    }
  } else {
    context = { type: 'empty', node: null, nodes: [] };
  }
  
  contextMenuTarget = context;
  const items = buildMenuItems(context);
  renderMenuItems(items);
  positionElement(contextMenu, e.clientX, e.clientY);
});

// Menu item click handler
contextMenu.addEventListener('click', (e) => {
  const item = e.target.closest('.context-menu-item');
  if (item) {
    handleMenuAction(item.dataset.action);
  }
});

// Color picker click handler - select and live-update for editing
document.querySelectorAll('.color-option').forEach(el => {
  el.addEventListener('click', async () => {
    // Remove selection from all colors
    document.querySelectorAll('.color-option').forEach(opt => opt.classList.remove('selected'));
    // Select the clicked color
    el.classList.add('selected');
    
    // For editing existing groups, update color immediately (live preview like Chrome)
    if (editingGroupContext && editingGroupContext.type === 'group') {
      const groupId = editingGroupContext.node.data.groupId;
      const color = el.dataset.color;
      await chrome.tabGroups.update(groupId, { color });
    }
  });
});

// Enter key in group name input
groupNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    // Stop bubbling to the document-level Enter handler, which would fire
    // createOrUpdateGroup a second time (dialog still open during the awaited group()).
    e.stopPropagation();
    const selectedColor = document.querySelector('.color-option.selected');
    const color = selectedColor ? selectedColor.dataset.color : 'grey';
    createOrUpdateGroup(color);
  } else if (e.key === 'Escape') {
    closeGroupDialog();
  }
});

// Click outside to close - close context menu on ANY click outside the menu
document.addEventListener('click', (e) => {
  // Close context menu if clicking anywhere outside of it
  if (contextMenu.classList.contains('show') && !contextMenu.contains(e.target)) {
    closeContextMenu();
  }
  // Close group dialog if clicking outside both dialog and context menu
  if (groupDialog.classList.contains('show') && !groupDialog.contains(e.target) && !contextMenu.contains(e.target)) {
    closeGroupDialog();
  }
});

// Also close context menu on mousedown for more responsive feel
document.addEventListener('mousedown', (e) => {
  if (contextMenu.classList.contains('show') && !contextMenu.contains(e.target)) {
    closeContextMenu();
  }
});

// Global keyboard shortcuts for dialogs
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeContextMenu();
    closeGroupDialog();
  }
  // Enter key to confirm group dialog (works even when focus is on color circles)
  if (e.key === 'Enter' && groupDialog.classList.contains('show')) {
    e.preventDefault();
    const selectedColor = document.querySelector('.color-option.selected');
    const color = selectedColor ? selectedColor.dataset.color : 'grey';
    createOrUpdateGroup(color);
  }
});

// =====================================================
// BOTTOM ACTION BAR FUNCTIONALITY
// =====================================================

// New Tab Button
document.getElementById('btn-new-tab').addEventListener('click', async () => {
  await chrome.tabs.create({});
});

// Auto Organize Button
document.getElementById('btn-auto-organize').addEventListener('click', async () => {
  await autoOrganize();
});

// =====================================================
// SAVED GROUPS DIALOG
// =====================================================

const savedGroupsDialog = document.getElementById('saved-groups-dialog');
const savedGroupsList = document.getElementById('saved-groups-list');
const savedGroupsBtn = document.getElementById('btn-saved-groups');

const GROUP_COLOR_MAP = {
  grey: '#5f6368', blue: '#1a73e8', red: '#d93025', yellow: '#e37400',
  green: '#188038', pink: '#d01884', purple: '#9334e6', cyan: '#007b83', orange: '#e25142'
};

// Human-friendly relative time (e.g. "2 days ago")
function relativeTime(ts) {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d > 1 ? 's' : ''} ago`;
  const mo = Math.floor(d / 30);
  return `${mo} month${mo > 1 ? 's' : ''} ago`;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function renderSavedGroups() {
  const { savedGroups = [] } = await chrome.runtime.sendMessage({ type: 'GET_SAVED_GROUPS' });
  savedGroupsList.innerHTML = '';

  if (savedGroups.length === 0) {
    savedGroupsList.innerHTML = `
      <div class="saved-groups-empty">
        <span class="material-icons">inbox</span>
        <span>No saved tab groups yet.<br>Groups you close are saved here automatically.</span>
      </div>`;
    return;
  }

  savedGroups.forEach(group => {
    const color = GROUP_COLOR_MAP[group.color] || '#5f6368';
    const name = group.name && group.name.trim() ? group.name : 'Untitled group';
    const tabCount = group.tabs ? group.tabs.length : 0;

    const row = document.createElement('div');
    row.className = 'saved-group-item';
    row.dataset.id = group.id;
    row.innerHTML = `
      <span class="saved-group-dot" style="background-color: ${color};"></span>
      <div class="saved-group-info">
        <span class="saved-group-name">${escapeHtml(name)}</span>
        <span class="saved-group-meta">${tabCount} tab${tabCount !== 1 ? 's' : ''} · ${relativeTime(group.lastUsed)}</span>
      </div>
      <span class="material-icons saved-group-delete" title="Delete saved group">delete</span>
    `;
    savedGroupsList.appendChild(row);
  });
}

function openSavedGroupsDialog() {
  closeContextMenu();
  closeGroupDialog();
  renderSavedGroups();
  savedGroupsDialog.style.display = 'block';
  setTimeout(() => savedGroupsDialog.classList.add('show'), 0);
}

function closeSavedGroupsDialog() {
  savedGroupsDialog.classList.remove('show');
  setTimeout(() => {
    if (!savedGroupsDialog.classList.contains('show')) {
      savedGroupsDialog.style.display = 'none';
    }
  }, 150);
}

savedGroupsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (savedGroupsDialog.classList.contains('show')) {
    closeSavedGroupsDialog();
  } else {
    openSavedGroupsDialog();
  }
});

document.getElementById('saved-groups-close').addEventListener('click', closeSavedGroupsDialog);

// Restore (row click) and delete (trash icon) via delegation
savedGroupsList.addEventListener('click', async (e) => {
  const item = e.target.closest('.saved-group-item');
  if (!item) return;
  const savedGroupId = item.dataset.id;

  if (e.target.closest('.saved-group-delete')) {
    e.stopPropagation();
    await chrome.runtime.sendMessage({ type: 'DELETE_SAVED_GROUP', savedGroupId });
    renderSavedGroups();
  } else {
    await chrome.runtime.sendMessage({ type: 'RESTORE_SAVED_GROUP', savedGroupId });
    closeSavedGroupsDialog();
  }
});

// Close on outside click / Escape
document.addEventListener('click', (e) => {
  if (savedGroupsDialog.classList.contains('show') &&
      !savedGroupsDialog.contains(e.target) &&
      !savedGroupsBtn.contains(e.target)) {
    closeSavedGroupsDialog();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && savedGroupsDialog.classList.contains('show')) {
    closeSavedGroupsDialog();
  }
});

// =====================================================
// SETTINGS MENU FUNCTIONALITY
// =====================================================

const settingsMenu = document.getElementById('settings-menu');
const settingsBtn = document.getElementById('btn-settings');

// Load and apply saved theme on init
async function loadTheme() {
  const { theme = 'auto' } = await chrome.storage.local.get('theme');
  applyTheme(theme);
}

// Apply theme to body and update segmented control
function applyTheme(theme) {
  // Remove all theme classes
  document.body.classList.remove('theme-light', 'theme-dark', 'theme-auto');
  
  // Add the selected theme class
  document.body.classList.add(`theme-${theme}`);
  
  // Update segmented control active state
  document.querySelectorAll('.theme-option').forEach(btn => {
    if (btn.dataset.theme === theme) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

// Toggle settings menu
function toggleSettingsMenu() {
  const isVisible = settingsMenu.classList.contains('show');
  
  if (isVisible) {
    closeSettingsMenu();
  } else {
    // Position menu above the settings button, aligned to bottom-right
    const btnRect = settingsBtn.getBoundingClientRect();
    
    // Show menu invisibly to measure its actual width
    settingsMenu.style.display = 'block';
    settingsMenu.style.opacity = '0';
    settingsMenu.style.visibility = 'hidden';
    
    // Get actual dimensions after content is rendered
    const menuRect = settingsMenu.getBoundingClientRect();
    const menuWidth = menuRect.width;
    
    // Position above button, with menu's RIGHT edge aligned to button's RIGHT edge
    let right = window.innerWidth - btnRect.right;
    let bottom = window.innerHeight - btnRect.top + 8; // 8px gap above button
    
    // Ensure menu doesn't go off-screen (left edge)
    let left = btnRect.right - menuWidth;
    if (left < 8) {
      left = 8;
      right = window.innerWidth - left - menuWidth;
    }
    
    settingsMenu.style.right = `${right}px`;
    settingsMenu.style.left = '';
    settingsMenu.style.bottom = `${bottom}px`;
    settingsMenu.style.opacity = '';
    settingsMenu.style.visibility = '';
    
    // Trigger animation by adding class after display is set
    setTimeout(() => settingsMenu.classList.add('show'), 0);
  }
}

// Close settings menu
function closeSettingsMenu() {
  settingsMenu.classList.remove('show');
  // Wait for animation to complete before hiding
  setTimeout(() => {
    if (!settingsMenu.classList.contains('show')) {
      settingsMenu.style.display = 'none';
    }
  }, 150); // Match transition duration
}

// Settings button click handler
settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleSettingsMenu();
});

// Theme option click handler
document.querySelectorAll('.theme-option').forEach(btn => {
  btn.addEventListener('click', async () => {
    const theme = btn.dataset.theme;
    applyTheme(theme);
    await chrome.storage.local.set({ theme });
  });
});

// Panel position menu item click handler
document.getElementById('settings-panel-position').addEventListener('click', () => {
  chrome.tabs.create({ 
    url: 'chrome://settings/appearance#:~:text=side%20panel%20position'
  });
  closeSettingsMenu();
});

// Request feature / Report bug menu item click handler
document.getElementById('settings-report-bug').addEventListener('click', () => {
  chrome.tabs.create({ 
    url: 'https://github.com/anandsingh1991/ChromeTreeBar/issues/new/choose'
  });
  closeSettingsMenu();
});

// About menu item click handler
document.getElementById('settings-about').addEventListener('click', () => {
  const version = chrome.runtime.getManifest().version;
  chrome.tabs.create({ 
    url: `https://github.com/anandsingh1991/ChromeTreeBar#readme`
  });
  closeSettingsMenu();
});

// Close settings menu on outside click
document.addEventListener('click', (e) => {
  if (settingsMenu.classList.contains('show') && 
      !settingsMenu.contains(e.target) && 
      !settingsBtn.contains(e.target)) {
    closeSettingsMenu();
  }
});

// Close settings menu on Escape (update existing keyboard handler)
const originalKeydownHandler = document.onkeydown;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settingsMenu.classList.contains('show')) {
    closeSettingsMenu();
  }
});

// Initialize theme on page load
loadTheme();

/**
 * Get grouping key from URL
 * Strips www. prefix, keeps other subdomains separate
 * www.amazon.com → "amazon.com"
 * code.amazon.com → "code.amazon.com"
 * 
 * Special handling for Chrome internal pages:
 * - All new tab variants → "newtab"
 * - chrome:// URLs → use the page name
 */
function getGroupingKey(url) {
  try {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol;
    const hostname = urlObj.hostname;
    
    // Handle Chrome internal URLs (chrome://, chrome-search://, etc.)
    if (protocol.startsWith('chrome')) {
      // Normalize all new tab page variants to "newtab"
      // Common variants: chrome://newtab, chrome://new-tab-page, chrome-search://local-ntp
      if (hostname === 'newtab' || hostname === 'new-tab-page' || hostname === 'local-ntp') {
        return 'newtab';
      }
      // For other chrome:// pages, use the hostname as-is
      return hostname;
    }
    
    // Standard URLs: strip www. prefix
    return hostname.replace(/^www\./, '');
  } catch (e) {
    return null;
  }
}

/**
 * Collect all tab IDs from a node and its descendants
 */
function collectAllTabIdsFromNode(node) {
  const ids = [];
  if (!node.data.isGroup) {
    ids.push(parseInt(node.key));
  }
  if (node.children) {
    node.children.forEach(child => {
      ids.push(...collectAllTabIdsFromNode(child));
    });
  }
  return ids;
}

/**
 * Capture parent-child edges among a set of Fancytree nodes (and their descendants),
 * keyed by real Chrome tab IDs. Only edges whose parent is ALSO in the grouped set are
 * kept, so nesting survives chrome.tabs.group() (which otherwise flattens via onTabUpdated).
 * Returns [{ tabId, parentId }] for re-applying after grouping.
 */
function captureTreeEdges(rootNodes) {
  const inSet = new Set();
  const walk = (n) => {
    if (!n.data.isGroup) inSet.add(parseInt(n.key));
    if (n.children) n.children.forEach(walk);
  };
  rootNodes.forEach(walk);

  const edges = [];
  const emit = (n, parentTabId) => {
    if (n.data.isGroup) return;
    const tabId = parseInt(n.key);
    edges.push({ tabId, parentId: parentTabId != null && inSet.has(parentTabId) ? parentTabId : null });
    if (n.children) n.children.forEach(c => emit(c, tabId));
  };
  rootNodes.forEach(n => emit(n, null));
  return edges;
}

/**
 * Auto-organize ungrouped root tabs by domain
 * - Adds tabs to existing groups if a group with matching domain name exists
 * - Creates new groups only for domains without existing groups
 */
async function autoOrganize() {
  if (!tree || !tree.fancytree('getTree')) return;
  
  const rootNode = tree.fancytree('getRootNode');
  const rootChildren = rootNode.children || [];
  
  // Build map of existing groups by their title (domain name)
  const existingGroups = {};
  rootChildren.forEach(node => {
    if (node.data.isGroup && node.title) {
      const groupKey = node.title.toLowerCase().trim();
      existingGroups[groupKey] = node.data.groupId;
      console.log(`Auto-organize: Found existing group "${node.title}" -> key="${groupKey}", groupId=${node.data.groupId}`);
    }
  });
  console.log('Auto-organize: existingGroups map:', existingGroups);
  
  // Filter to only ungrouped root tabs (not groups, not already in a group)
  const ungroupedRootTabs = rootChildren.filter(node => {
    const groupId = node.data.groupId;
    // Handle both number and string representations of -1, plus undefined/null
    const isUngrouped = !node.data.isGroup && (groupId === -1 || groupId === '-1' || groupId === undefined || groupId === null);
    console.log(`Auto-organize: Checking tab "${node.title}" - isGroup=${node.data.isGroup}, groupId=${groupId} (type: ${typeof groupId}), isUngrouped=${isUngrouped}`);
    return isUngrouped;
  });
  
  if (ungroupedRootTabs.length === 0) {
    console.log('Auto-organize: No ungrouped root tabs to organize');
    return;
  }
  
  // Build domain map: groupingKey → [nodes]
  const domainMap = {};
  ungroupedRootTabs.forEach(node => {
    const key = getGroupingKey(node.data.url);
    console.log(`Auto-organize: Tab "${node.title}" URL="${node.data.url}" -> groupingKey="${key}"`);
    if (key) {
      if (!domainMap[key]) domainMap[key] = [];
      domainMap[key].push(node);
    }
  });
  console.log('Auto-organize: domainMap:', Object.keys(domainMap));
  
  // Get colors already in use by existing groups
  const usedColors = new Set();
  rootChildren.forEach(node => {
    if (node.data.isGroup && node.data.color) {
      usedColors.add(node.data.color);
    }
  });
  
  // Chrome's tab group colors in sequence
  const allColors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
  
  // Filter to unused colors, fallback to all if all are used
  const availableColors = allColors.filter(c => !usedColors.has(c));
  const colors = availableColors.length > 0 ? availableColors : allColors;
  
  console.log('Auto-organize: Used colors:', Array.from(usedColors));
  console.log('Auto-organize: Available colors:', colors);
  
  let colorIndex = 0;
  let groupsCreated = 0;
  let tabsAddedToExisting = 0;
  
  // Process each domain
  for (const [domain, nodes] of Object.entries(domainMap)) {
    // Collect all tab IDs (including children of each root tab)
    const allTabIds = [];
    nodes.forEach(node => {
      allTabIds.push(...collectAllTabIdsFromNode(node));
    });
    
    // Remove duplicates
    const uniqueTabIds = [...new Set(allTabIds)];

    if (uniqueTabIds.length === 0) continue;

    // Capture nesting BEFORE grouping so we can restore it afterward (group() flattens it)
    const treeEdges = captureTreeEdges(nodes);

    // Check if a group with this domain name already exists
    const domainKey = domain.toLowerCase().trim();
    const existingGroupId = existingGroups[domainKey];
    console.log(`Auto-organize: Looking for group with key="${domainKey}", found groupId=${existingGroupId}`);

    if (existingGroupId) {
      // Add to existing group
      try {
        await chrome.tabs.group({ groupId: existingGroupId, tabIds: uniqueTabIds });
        tabsAddedToExisting += uniqueTabIds.length;
        await chrome.runtime.sendMessage({ type: 'RESTORE_TREE_STRUCTURE', edges: treeEdges, groupId: existingGroupId });
        console.log(`Auto-organize: Added ${uniqueTabIds.length} tabs to existing group "${domain}"`);
      } catch (e) {
        console.error(`Auto-organize: Failed to add tabs to existing group "${domain}"`, e);
      }
    } else if (nodes.length >= 2) {
      // Create new group only if 2+ tabs share this domain (and no existing group)
      try {
        const groupId = await chrome.tabs.group({ tabIds: uniqueTabIds });
        await chrome.tabGroups.update(groupId, {
          title: domain,
          color: colors[colorIndex % colors.length]
        });
        await chrome.runtime.sendMessage({ type: 'RESTORE_TREE_STRUCTURE', edges: treeEdges, groupId });
        colorIndex++;
        groupsCreated++;
        console.log(`Auto-organize: Created new group "${domain}" with ${uniqueTabIds.length} tabs`);
      } catch (e) {
        console.error(`Auto-organize: Failed to create group for "${domain}"`, e);
      }
    }
  }
  
  console.log(`Auto-organize: Created ${groupsCreated} new groups, added tabs to ${tabsAddedToExisting} existing`);
  
  // Force immediate reload after auto-organize completes
  // This ensures the view reflects the new group structure right away
  // without waiting for Chrome events to propagate
  reloadTree();
}
