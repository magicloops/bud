import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer as createHttpServer, request } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

test('HTTP development forwards daemon browser media upgrades to the service', { timeout: 10_000 }, async () => {
  const upstream = createHttpServer((_req, res) => res.writeHead(426).end())
  const sockets = new Set<Socket>()
  upstream.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  let forwardedPath: string | undefined
  upstream.on('upgrade', (req, socket) => {
    forwardedPath = req.url
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const previousTarget = process.env.VITE_API_PROXY_TARGET
  process.env.VITE_API_PROXY_TARGET = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  let vite: Awaited<ReturnType<typeof createServer>> | undefined
  try {
    vite = await createServer({
      configFile: fileURLToPath(new URL('./vite.config.ts', import.meta.url)),
      server: { host: '127.0.0.1', port: 0, strictPort: true },
      optimizeDeps: { noDiscovery: true, include: [] },
      logLevel: 'silent',
    })
    await vite.listen()
    const port = (vite.httpServer!.address() as AddressInfo).port
    await new Promise<void>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1', port, path: '/ws/browser-media',
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        },
      })
      const timeout = setTimeout(() => req.destroy(new Error('Browser media upgrade did not reach the service')), 2_000)
      req.on('error', error => { clearTimeout(timeout); reject(error) })
      req.on('response', response => {
        clearTimeout(timeout)
        response.resume()
        reject(new Error(`Expected a WebSocket upgrade, received HTTP ${response.statusCode}`))
      })
      req.on('upgrade', (response, socket) => {
        clearTimeout(timeout)
        socket.destroy()
        try {
          assert.equal(response.statusCode, 101)
          assert.equal(forwardedPath, '/ws/browser-media')
          resolve()
        } catch (error) { reject(error) }
      })
      req.end()
    })
  } finally {
    for (const socket of sockets) socket.destroy()
    await vite?.close()
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
    if (previousTarget === undefined) delete process.env.VITE_API_PROXY_TARGET
    else process.env.VITE_API_PROXY_TARGET = previousTarget
  }
})
