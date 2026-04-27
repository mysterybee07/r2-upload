import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { readdirSync } from 'node:fs'
import { resolve, parse } from 'node:path'
import { pathToFileURL } from 'node:url'

// Mounts every file in /api as a Vercel-style serverless function on the Vite dev server.
// Replaces the need for `vercel dev` during local development.
function vercelApiDevPlugin() {
  return {
    name: 'vercel-api-dev',
    async configureServer(server) {
      const apiDir = resolve(process.cwd(), 'api')
      let files = []
      try {
        files = readdirSync(apiDir).filter((f) => /\.(m?js|ts)$/.test(f))
      } catch {
        return
      }

      for (const file of files) {
        const route = '/api/' + parse(file).name
        const fileUrl = pathToFileURL(resolve(apiDir, file)).href

        let handler
        try {
          const mod = await import(fileUrl)
          handler = mod.default
        } catch (err) {
          console.error(`[api] failed to load ${file}:`, err)
          continue
        }
        if (typeof handler !== 'function') continue

        server.middlewares.use(route, async (req, res) => {
          if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            const ct = req.headers['content-type'] || ''
            if (ct.includes('application/json')) {
              try {
                req.body = await readJsonBody(req)
              } catch {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: 'Invalid JSON body' }))
                return
              }
            }
          }

          // Vercel-style response sugar
          res.status = (code) => {
            res.statusCode = code
            return res
          }
          res.json = (data) => {
            if (!res.getHeader('Content-Type')) {
              res.setHeader('Content-Type', 'application/json')
            }
            res.end(JSON.stringify(data))
            return res
          }

          try {
            await handler(req, res)
          } catch (err) {
            console.error('[api] handler error:', err)
            if (!res.writableEnded) {
              res.statusCode = 500
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'Internal error' }))
            }
          }
        })

        console.log(`[api] mounted ${route} -> api/${file}`)
      }
    },
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

export default defineConfig(({ mode }) => {
  // Load .env / .env.local into process.env so API handlers can read them
  const env = loadEnv(mode, process.cwd(), '')
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) process.env[key] = value
  }

  return {
    plugins: [react(), vercelApiDevPlugin()],
    server: { port: 5173 },
  }
})
