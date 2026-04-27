import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'node:crypto'

function env(name) {
  const v = process.env[name]
  return typeof v === 'string' ? v.trim() : v
}

const REQUIRED_VARS = [
  'STORAGE_PROVIDER',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_ENDPOINT',
  'R2_PUBLIC_BASE_URL',
]

let s3Client

function getClient() {
  if (!s3Client) {
    s3Client = new S3Client({
      region: 'auto',
      endpoint: env('R2_ENDPOINT'),
      credentials: {
        accessKeyId: env('R2_ACCESS_KEY_ID'),
        secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
      },
      // R2 doesn't support the AWS SDK v3 default flexible-checksum behavior;
      // leaving these on can produce signed URLs that R2 rejects with a signature mismatch.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })
  }
  return s3Client
}

const IS_PRODUCTION = process.env.VERCEL_ENV === 'production'

const MAX_FILENAME_LEN = 255

function sanitizeExt(filename) {
  const dot = filename.lastIndexOf('.')
  if (dot === -1 || dot === filename.length - 1) return 'bin'
  const ext = filename.slice(dot + 1).toLowerCase()
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : 'bin'
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const missing = REQUIRED_VARS.filter((name) => !env(name))
  const provider = (env('STORAGE_PROVIDER') || '').toLowerCase()

  // GET = diagnostic, dev/preview only. Disabled in production to avoid leaking
  // bucket/endpoint metadata to scrapers.
  if (req.method === 'GET') {
    if (IS_PRODUCTION) return res.status(404).json({ error: 'Not found' })
    return res.status(200).json({
      ok: missing.length === 0 && provider === 'r2',
      storageProvider: env('STORAGE_PROVIDER') ?? null,
      missing,
      seen: REQUIRED_VARS.reduce((acc, name) => {
        const v = env(name)
        acc[name] = !v
          ? 'missing'
          : name === 'R2_SECRET_ACCESS_KEY' || name === 'R2_ACCESS_KEY_ID'
          ? `set (${v.length} chars)`
          : v
        return acc
      }, {}),
    })
  }

  if (missing.length > 0) {
    return res.status(500).json({
      error: `Missing env vars: ${missing.join(', ')}. Hit GET /api/presign for a diagnostic.`,
    })
  }

  if (provider !== 'r2') {
    return res.status(500).json({
      error: `STORAGE_PROVIDER must be "r2" (got: ${JSON.stringify(env('STORAGE_PROVIDER'))}). Hit GET /api/presign for a diagnostic.`,
    })
  }

  const { filename, contentType } = req.body || {}

  if (!filename || typeof filename !== 'string' || filename.length > MAX_FILENAME_LEN) {
    return res.status(400).json({ error: 'Invalid filename' })
  }

  if (!contentType || typeof contentType !== 'string' || !contentType.startsWith('image/')) {
    return res.status(400).json({ error: 'Only image content types are allowed' })
  }

  try {
    const ext = sanitizeExt(filename)
    const key = `uploads/${Date.now()}-${randomUUID()}.${ext}`

    const command = new PutObjectCommand({
      Bucket: env('R2_BUCKET'),
      Key: key,
      ContentType: contentType,
    })

    const uploadUrl = await getSignedUrl(getClient(), command, { expiresIn: 60 * 5 })
    const publicUrl = `${env('R2_PUBLIC_BASE_URL').replace(/\/$/, '')}/${key}`

    return res.status(200).json({ uploadUrl, publicUrl, key })
  } catch (err) {
    console.error('presign error', err)
    return res.status(500).json({ error: 'Failed to create presigned URL' })
  }
}
