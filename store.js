/* Session storage. Global: window.Store
 *
 * Video files live in IndexedDB keyed by clip id; the rest of the project is one
 * small JSON record. Reloading the page — or coming back tomorrow — restores the
 * session instead of throwing the work away.
 */
(function () {
  'use strict';

  var DB = 'captioner';
  var VERSION = 1;
  var BLOBS = 'blobs';
  var META = 'meta';
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('no IndexedDB')); return; }
      var req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'k' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB unavailable')); };
      req.onblocked = function () { reject(new Error('IndexedDB blocked')); };
    }).catch(function (e) { dbPromise = null; throw e; });
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, mode);
        var req = fn(t.objectStore(store));
        t.oncomplete = function () { resolve(req && req.result); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('aborted')); };
      });
    });
  }

  function putClip(id, file) {
    return tx(BLOBS, 'readwrite', function (s) {
      return s.put({ id: id, blob: file, name: file.name || 'clip', type: file.type || '' });
    });
  }
  function getClips() {
    return tx(BLOBS, 'readonly', function (s) { return s.getAll(); }).then(function (r) { return r || []; });
  }
  function deleteClip(id) {
    return tx(BLOBS, 'readwrite', function (s) { return s.delete(id); });
  }
  function saveProject(obj) {
    return tx(META, 'readwrite', function (s) { return s.put({ k: 'project', v: obj }); });
  }
  function loadProject() {
    return tx(META, 'readonly', function (s) { return s.get('project'); })
      .then(function (r) { return r ? r.v : null; });
  }
  function clear() {
    return Promise.all([
      tx(BLOBS, 'readwrite', function (s) { return s.clear(); }),
      tx(META, 'readwrite', function (s) { return s.clear(); })
    ]);
  }

  // Without this the browser may evict the whole session under storage pressure.
  function requestPersistence() {
    if (navigator.storage && navigator.storage.persist) {
      return navigator.storage.persisted().then(function (already) {
        return already ? true : navigator.storage.persist();
      }).catch(function () { return false; });
    }
    return Promise.resolve(false);
  }

  function usage() {
    if (navigator.storage && navigator.storage.estimate) {
      return navigator.storage.estimate().catch(function () { return null; });
    }
    return Promise.resolve(null);
  }

  window.Store = {
    putClip: putClip, getClips: getClips, deleteClip: deleteClip,
    saveProject: saveProject, loadProject: loadProject, clear: clear,
    requestPersistence: requestPersistence, usage: usage
  };
})();
