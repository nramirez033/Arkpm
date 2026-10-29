const { contextBridge, ipcRenderer } = require('electron');
const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (cb) => { const h = (_e, ...a) => cb(...a); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); };

contextBridge.exposeInMainWorld('electronAPI', {
  sshConnect: inv('ssh:connect'), sshDisconnect: inv('ssh:disconnect'), sshExec: inv('ssh:exec'),
  sshStreamStart: inv('ssh:streamStart'), sshStreamStop: inv('ssh:streamStop'),
  sshList: inv('ssh:list'), sshStat: inv('ssh:stat'), sshReadFile: inv('ssh:readFile'), sshWriteFile: inv('ssh:writeFile'),
  sshUploadMany: inv('ssh:uploadMany'), sshDownload: inv('ssh:download'), sshCancelJob: inv('ssh:cancelJob'),
  onSshStream: on('ssh:stream'), onSshProgress: on('ssh:progress'), onSshClosed: on('ssh:closed'),
  pickFiles: inv('local:pickFiles'), pickFolder: inv('local:pickFolder'), pickSaveDir: inv('local:pickSaveDir'),
  walkLocal: inv('local:walk'), showItem: inv('local:showItem'), openFolder: inv('local:openFolder'), pathExists: inv('local:exists'),
  secretSave: inv('secret:save'), secretLoad: inv('secret:load'), secretDelete: inv('secret:delete'),
  dbExec: inv('db:exec'), dbRun: inv('db:run'), dbAll: inv('db:all'), dbTx: inv('db:tx'),
  monitorConfigure: inv('monitor:configure'), monitorStatus: inv('monitor:status'), monitorMute: inv('monitor:mute'),
  desktopGet: inv('desktop:get'), desktopSet: inv('desktop:set'),
  notifyTest: inv('notify:test'), notifyPermission: inv('notify:permission'), onNotifyClick: on('notify:click'),
  winMinimize: inv('win:minimize'), winToggleMax: inv('win:toggleMax'), winClose: inv('win:close'), winIsMax: inv('win:isMax'),
  onWinState: on('win:state'), platform: inv('app:platform'),
});
