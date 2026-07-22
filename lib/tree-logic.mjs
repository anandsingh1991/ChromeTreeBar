// Pure, chrome.*-free tree/dedup/cap logic for Saved Groups + tree-preserving grouping (v1.2.0).
// Imported by background.js (module service worker) and by tasks/test-tree-logic.mjs.
// Keep this file free of any chrome.* / DOM references so it stays unit-testable in Node.

/**
 * Build a group's snapshot tab list with stable tempIds and intra-group parent edges.
 * @param {Array<{id:number,title:string,url:string}>} groupTabs  tabs in desired order
 * @param {Map<number,{parentId:number|null}>} tabTree            live tree (tabId -> node)
 * @returns {Array<{title:string,url:string,tempId:number,parentTempId:number|null}>}
 */
export function buildParentTempMap(groupTabs, tabTree) {
  const idToTemp = new Map();
  groupTabs.forEach((t, i) => idToTemp.set(t.id, i)); // tempId = index within the snapshot

  return groupTabs.map((t, i) => {
    const node = tabTree.get(t.id);
    const parentId = node ? node.parentId : null;
    // Only encode the edge when the parent is ALSO inside this group; otherwise it becomes a root.
    const parentTempId =
      parentId != null && idToTemp.has(parentId) ? idToTemp.get(parentId) : null;
    return { title: t.title, url: t.url, tempId: i, parentTempId };
  });
}

/**
 * After restore, map every reopened snapshot tab to its intended parent (or root).
 * Tabs that failed to reopen are skipped; edges pointing at a skipped parent fall back to root.
 * @param {Array<{tempId:number,parentTempId:number|null}>} snapshotTabs
 * @param {Map<number,number>} tempIdToNewTabId  tempId -> freshly created tabId
 * @returns {Array<{tabId:number,parentId:number|null}>}
 */
export function computeRestoreAssignments(snapshotTabs, tempIdToNewTabId) {
  const assignments = [];
  for (const t of snapshotTabs) {
    const tabId = tempIdToNewTabId.get(t.tempId);
    if (tabId == null) continue;
    const parentId =
      t.parentTempId != null ? (tempIdToNewTabId.get(t.parentTempId) ?? null) : null;
    assignments.push({ tabId, parentId });
  }
  return assignments;
}

/**
 * Dedup saved groups by name+color. On match: update tabs + lastUsed and move to front.
 * Otherwise prepend the new snapshot.
 *
 * Only NAMED groups dedupe: Chrome groups are unnamed by default (name === ''), so
 * matching on an empty name would collapse two unrelated untitled groups of the same
 * color into one and lose the first's tabs. Untitled groups always get their own entry.
 */
export function dedupeSavedGroup(savedGroups, newSnap) {
  const hasName = newSnap.name != null && newSnap.name.trim() !== '';
  const idx = hasName
    ? savedGroups.findIndex((g) => g.name === newSnap.name && g.color === newSnap.color)
    : -1;
  if (idx >= 0) {
    const updated = { ...savedGroups[idx], tabs: newSnap.tabs, lastUsed: newSnap.lastUsed };
    const rest = savedGroups.filter((_, i) => i !== idx);
    return [updated, ...rest];
  }
  return [newSnap, ...savedGroups];
}

/** Cap to `limit`, dropping the oldest by lastUsed. */
export function capSavedGroups(savedGroups, limit) {
  if (savedGroups.length <= limit) return savedGroups;
  // Treat a missing lastUsed (legacy storage) as oldest, else NaN comparisons make
  // the sort indeterminate and the cap can drop recently-used groups.
  const ts = (g) => (typeof g.lastUsed === 'number' ? g.lastUsed : 0);
  return [...savedGroups].sort((a, b) => ts(b) - ts(a)).slice(0, limit);
}
