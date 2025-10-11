/* Refloow Video Editor
 * Copyright (C) 2025  Veljko Vuckovic (Refloow) <legal@refloow.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */


// main.js

// Modules to control application life and create native browser window
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

// Add a guard clause to ensure the app is run with Electron, not Node
if (!app) {
    console.error("This script must be run through the Electron runtime.");
    console.error("Please run the app using 'npm start' from your project directory.");
    process.exit(1);
}

let mainWindow;
let ffmpegPath;
let ffprobePath;

/**
 * Probes a video file to get its properties like width, height, and duration.
 * @param {string} filePath - The path to the video file.
 * @returns {Promise<{width: number, height: number, duration: number}>}
 */
function getVideoProperties(filePath) {
    return new Promise((resolve, reject) => {
        const args = [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height,duration',
            '-of', 'json',
            filePath
        ];

        let jsonData = '';
        const ffprobeProcess = spawn(ffprobePath, args);

        ffprobeProcess.stdout.on('data', (data) => {
            jsonData += data.toString();
        });

        ffprobeProcess.stderr.on('data', (data) => {
            console.error(`ffprobe stderr: ${data}`);
        });

        ffprobeProcess.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(`ffprobe exited with code ${code} for file ${filePath}`));
            }
            try {
                const parsedData = JSON.parse(jsonData);
                const stream = parsedData.streams[0];
                resolve({
                    width: stream.width,
                    height: stream.height,
                    duration: parseFloat(stream.duration)
                });
            } catch (e) {
                reject(new Error(`Failed to parse ffprobe output for ${filePath}. Error: ${e.message}`));
            }
        });

        ffprobeProcess.on('error', (err) => {
             reject(new Error(`Failed to start ffprobe process for ${filePath}. Error: ${err.message}`));
        });
    });
}


function createWindow() {
    // Create the browser window.
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        icon: __dirname + '/img/icon.ico',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        autoHideMenuBar: true,
    });
    mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
    const isDev = !app.isPackaged;
    const ffmpegExecutable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const ffprobeExecutable = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
    const ffplayExecutable = process.platform === 'win32' ? 'ffplay.exe' : 'ffplay'; // If you have ffplay

    if (isDev) {
        ffmpegPath = path.join(__dirname, 'resources', ffmpegExecutable);
        ffprobePath = path.join(__dirname, 'resources', ffprobeExecutable);
        ffplayPath = path.join(__dirname, 'resources', ffplayExecutable);
    } else {
        // For packaged apps, `process.resourcesPath` points to the `resources` directory
        // but `asarUnpack` places our tools in `resources/app.asar.unpacked/resources`
        const unpackedResourcesPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'resources');
        
        // Verify the path exists before assigning, for better error handling
        if (!fs.existsSync(unpackedResourcesPath)) {
            console.error(`Error: Unpacked resources path not found: ${unpackedResourcesPath}`);
            dialog.showErrorBox('Initialization Error', `Required media tools not found. Please ensure the app is correctly installed. Path: ${unpackedResourcesPath}`);
            app.quit();
            return;
        }

        ffmpegPath = path.join(unpackedResourcesPath, ffmpegExecutable);
        ffprobePath = path.join(unpackedResourcesPath, ffprobeExecutable);
        ffplayPath = path.join(unpackedResourcesPath, ffplayExecutable);

        // Basic check to see if executables exist
        if (!fs.existsSync(ffmpegPath)) console.error(`FFmpeg not found at: ${ffmpegPath}`);
        if (!fs.existsSync(ffprobePath)) console.error(`FFprobe not found at: ${ffprobePath}`);
        if (!fs.existsSync(ffplayPath)) console.error(`FFplay not found at: ${ffplayPath}`);
    }

    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('dialog:openFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Movies', extensions: ['mkv', 'avi', 'mp4', 'mov'] }]
    });
    return canceled ? [] : filePaths;
});

// Handle final video rendering
ipcMain.handle('render-video', async (event, edl) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Save Video',
        defaultPath: `rendered-video-${Date.now()}.mp4`,
        filters: [{ name: 'MP4 Video', extensions: ['mp4'] }]
    });

    if (canceled || !filePath) {
        return { success: false, message: 'Render cancelled.' };
    }

    const videoClips = edl.video;
    if (!videoClips || videoClips.length === 0) {
        return { success: false, message: 'No video clips to render.' };
    }
    
    // --- Advanced FFmpeg Command Generation ---
    let targetWidth, targetHeight;
    let totalDuration = videoClips.reduce((acc, clip) => acc + clip.duration, 0);

    try {
        const firstClipProps = await getVideoProperties(videoClips[0].filePath);
        targetWidth = firstClipProps.width;
        targetHeight = firstClipProps.height;
    } catch (error) {
        console.error("Failed to get video properties:", error);
        return { success: false, message: `Failed to read video properties: ${error.message}` };
    }
    
    const uniqueFiles = [...new Set(videoClips.map(clip => clip.filePath))];
    const inputs = uniqueFiles.flatMap(file => ['-i', file]);
    const fileIndexMap = new Map(uniqueFiles.map((file, index) => [file, index]));

    let filterComplex = '';
    let concatStreams = '';

    videoClips.forEach((clip, index) => {
        const inputIndex = fileIndexMap.get(clip.filePath);
        const endOffset = clip.startOffset + clip.duration;
        filterComplex += `[${inputIndex}:v:0]trim=start=${clip.startOffset}:end=${endOffset},setpts=PTS-STARTPTS[v${index}_t];`;
        filterComplex += `[v${index}_t]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${index}];`;
        filterComplex += `[${inputIndex}:a:0]atrim=start=${clip.startOffset}:end=${endOffset},asetpts=PTS-STARTPTS[a${index}];`;
        concatStreams += `[v${index}][a${index}]`;
    });
    
    filterComplex += `${concatStreams}concat=n=${videoClips.length}:v=1:a=1[outv][outa]`;

    const args = [
        '-progress', 'pipe:1',
        ...inputs,
        '-filter_complex', filterComplex,
        '-map', '[outv]',
        '-map', '[outa]',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '22',
        '-y',
        filePath
    ];

    return new Promise((resolve) => {
        const ffmpegProcess = spawn(ffmpegPath, args);

        const sendProgress = (progress) => {
            mainWindow.webContents.send('render-progress', { progress });
        };
        
        ffmpegProcess.stdout.on('data', (data) => {
            const output = data.toString();
            const timeMatch = output.match(/out_time_ms=(\d+)/);
            if (timeMatch) {
                const currentTimeMs = parseInt(timeMatch[1], 10) / 1000000;
                const progress = Math.min(100, (currentTimeMs / totalDuration) * 100);
                sendProgress(progress.toFixed(2));
            }
        });
        
        let stderr = '';
        ffmpegProcess.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        ffmpegProcess.on('close', (code) => {
            if (code === 0) {
                sendProgress(100);
                resolve({ success: true, filePath });
            } else {
                console.error('FFmpeg Error:', stderr);
                resolve({ success: false, message: `FFmpeg failed with code ${code}. Details: ${stderr.slice(-500)}` });
            }
        });
        
        ffmpegProcess.on('error', (err) => {
            resolve({ success: false, message: `Failed to start FFmpeg. Error: ${err.message}` });
        });
    });
});

/* Refloow Video Editor
 * Copyright (C) 2025  Veljko Vuckovic (Refloow) <legal@refloow.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
