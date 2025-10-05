// * Original work: Copyright (c) Veljko Vuckovic (Refloow.com) All rights reserved.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    openFile: () => ipcRenderer.invoke('dialog:openFile'),
    renderVideo: (editDecisionList) => ipcRenderer.invoke('render-video', editDecisionList),
    onRenderProgress: (callback) => {
        const handler = (_event, value) => callback(value);
        ipcRenderer.on('render-progress', handler);
        
        return () => {
            ipcRenderer.removeListener('render-progress', handler);
        };
    }
});

// * Original work: Copyright (c) Veljko Vuckovic (Refloow.com) All rights reserved.

