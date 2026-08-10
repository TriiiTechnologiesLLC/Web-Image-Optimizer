/*
Copyright 2026 Triii Technologies LLC

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR DEALINGS IN THE SOFTWARE.
*/

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { processBatch, iconKitGeneration } = require("./gui_logic");

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 700,
        frame: false,
        titleBarStyle: 'hidden',
        titleBarOverlay: {
            color: '#1e1e2e',
            symbolColor: '#cdd6f4',
            height: 36
        },
        webPreferences: {
            nodeIntegration: false,   // 🛡️ SECURITY: Disable Node in renderer
            contextIsolation: true,   // 🛡️ SECURITY: Enable isolation
            preload: path.join(__dirname, 'preload.js') // 🔗 Attach our bridge
        },
        icon: path.join(__dirname, 'assets/icons/fav.png')
    });

    mainWindow.loadFile('index.html');
}

// ─── IPC: Directory Picker ────────────────────────────────────────────

ipcMain.handle('select-directory', async (_event, title) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: title || 'Select Folder',
        properties: ['openDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
});

// ─── IPC: File Picker (for source image) ──────────────────────────────

ipcMain.handle('select-file', async (_event, title) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: title || 'Select Source Image',
        properties: ['openFile'],
        filters: [
            { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
            { name: 'All Files', extensions: ['*'] }
        ]
    });
    return result.canceled ? null : result.filePaths[0];
});

// ─── IPC: Batch Image Processing (with optional icon kit) ─────────────

ipcMain.handle('process-images', async (_event, inputPath, outputPath, options) => {
    try {
        const opts = Object.assign({}, options);

        if (opts.generateIcons && !opts.sourceImageForIcons) {
            return {
                success: false,
                data: { log: 'Icon generation requires a source image. Use the dedicated icon kit generator.', success: 0, failures: 0 }
            };
        }

        const result = await processBatch(inputPath, outputPath, opts);
        return { success: true, data: result };
    } catch (error) {
        console.error('[Main] Processing failed:', error);
        return { success: false, error: error.message || 'Unknown processing error' };
    }
});

// ─── IPC: Dedicated Icon Kit Generation ───────────────────────────────

ipcMain.handle('generate-icon-kit', async (_event, sourceImagePath, outputBase) => {
    try {
        const result = await iconKitGeneration(sourceImagePath, outputBase);
        return { success: true, data: result };
    } catch (error) {
        console.error('[Main] Icon kit generation failed:', error);
        return { success: false, error: error.message || 'Icon kit generation failed' };
    }
});

// ─── IPC: Open External URL ──────────────────────────────────────────

ipcMain.on('open-external-url', (event, url) => {
    console.log("Main process opening:", url);
    shell.openExternal(url);
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});