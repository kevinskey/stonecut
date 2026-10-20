// StoneCut desktop shell.
//
// Loads the live site so the app is always on the latest engine (no stale
// bundle), and falls back to the dist/ copy packed inside the app when the
// studio is offline. WebUSB reaches the Graphtec because this is Chromium —
// the three handlers below replace Chrome's device-picker UI, which Electron
// does not have: the first Graphtec on the bus is granted automatically.
const { app, BrowserWindow, Menu, shell, session } = require('electron')
const path = require('node:path')

const LIVE_URL = 'https://rhinestones.tshirtbrothers.com/'
const GRAPHTEC = 0x0b4d

const localIndex = () => path.join(__dirname, '..', 'dist', 'index.html')

function wireUsb(ses) {
  ses.on('select-usb-device', (event, details, callback) => {
    event.preventDefault()
    const dev = details.deviceList.find((d) => d.vendorId === GRAPHTEC)
    callback(dev?.deviceId)
  })
  ses.setPermissionCheckHandler(() => true)
  ses.setDevicePermissionHandler((details) => details.deviceType === 'usb' && details.device.vendorId === GRAPHTEC)
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'StoneCut',
    backgroundColor: '#12151c',
    webPreferences: { spellcheck: false },
  })
  win.webContents.on('did-fail-load', (_e, code) => {
    // offline (or the droplet is down): use the copy shipped in the app
    if (code !== -3 /* aborted: user navigation, not a failure */) win.loadFile(localIndex())
  })
  // external links (help pages etc.) open in the browser, not in the shell
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  // Mac App Store build: run the bundled app (review guideline 4.2 — a
  // storefront app must not be a thin wrapper around a website). The direct
  // dmg build keeps tracking the live site so it is always on the newest
  // engine.
  if (process.mas) win.loadFile(localIndex())
  else win.loadURL(LIVE_URL)
  return win
}

app.whenReady().then(() => {
  wireUsb(session.defaultSession)
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'fileMenu' },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
          { role: 'toggleDevTools' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  )
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => app.quit())
