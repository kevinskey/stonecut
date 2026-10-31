const { pathToFileURL } = require('node:url')
const path = require('node:path')
const LIVE_ORIGIN = 'https://rhinestones.tshirtbrothers.com'
const localUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href
function trustedDocument(url) {
  try { const u = new URL(url); return (u.origin === LIVE_ORIGIN && u.pathname === '/') || u.href.split(/[?#]/)[0] === localUrl } catch { return false }
}
function externalUrl(url) { try { return ['https:', 'http:'].includes(new URL(url).protocol) } catch { return false } }
module.exports = { trustedDocument, externalUrl, LIVE_ORIGIN }
