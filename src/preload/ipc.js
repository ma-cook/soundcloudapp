const { contextBridge, ipcRenderer } = require('electron');

// Allowlists: the renderer can only reach these channels. Feature modules
// extend both sets as they register new ipcMain handlers / events.
const INVOKE_CHANNELS = new Set(['app:getInfo']);
const EVENT_CHANNELS = new Set([]);

/**
 * Invoke a whitelisted main-process handler.
 * @param {string} channel
 * @param {unknown} [payload]
 * @returns {Promise<unknown>}
 */
function invoke(channel, payload) {
  if (!INVOKE_CHANNELS.has(channel)) {
    return Promise.reject(new Error(`Channel "${channel}" is not exposed to the renderer`));
  }
  return ipcRenderer.invoke(channel, payload);
}

/**
 * Subscribe to a main-process event with automatic cleanup support.
 * @param {string} channel
 * @param {(payload: unknown) => void} listener
 * @returns {() => void} unsubscribe function
 */
function subscribe(channel, listener) {
  if (!EVENT_CHANNELS.has(channel)) {
    throw new Error(`Channel "${channel}" is not exposed to the renderer`);
  }
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api = {
  invoke,
  subscribe,
  app: {
    getInfo: () => ipcRenderer.invoke('app:getInfo'),
  },
};

contextBridge.exposeInMainWorld('cube', api);