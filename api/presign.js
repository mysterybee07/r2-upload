import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'node:crypto'

function env(name) {
  const v = process.env[name]
  return typeof v === 'string' ? v.trim() : v
}

const BASE_REQUIRED_VARS = ['STORAGE_PROVIDER']
const DEFAULT_ENV_NAMES = {
  bucket: 'R2_BUCKET',
  accessKeyId: 'R2_ACCESS_KEY_ID',
  secretAccessKey: 'R2_SECRET_ACCESS_KEY',
  endpoint: 'R2_ENDPOINT',
  publicBaseUrl: 'R2_PUBLIC_BASE_URL',
  folder: 'R2_FOLDER',
}
const COMPANY_REQUIRED_SUFFIXES = [
  'BUCKET',
  'ACCESS_KEY_ID',
  'SECRET_ACCESS_KEY',
  'ENDPOINT',
  'PUBLIC_BASE_URL',
  'FOLDER',
]

const s3Clients = new Map()

function getClient(config) {
  const cacheKey = [config.endpoint, config.accessKeyId, config.secretAccessKey].join('|')

  if (!s3Clients.has(cacheKey)) {
    s3Clients.set(
      cacheKey,
      new S3Client({
        region: 'auto',
        endpoint: config.endpoint,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        // R2 doesn't support the AWS SDK v3 default flexible-checksum behavior;
        // leaving these on can produce signed URLs that R2 rejects with a signature mismatch.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      }),
    )
  }

  return s3Clients.get(cacheKey)
}

const IS_PRODUCTION = process.env.VERCEL_ENV === 'production'

const MAX_FILENAME_LEN = 255

function getQueryParam(value) {
  if (Array.isArray(value)) return value[0]
  return typeof value === 'string' ? value : ''
}

function getCompanyParam(req) {
  const fromQuery = getQueryParam(req.query?.company).trim()
  if (fromQuery) return fromQuery

  const fromBody = typeof req.body?.company === 'string' ? req.body.company.trim() : ''
  return fromBody
}

function getFolderParam(req) {
  return typeof req.body?.folder === 'string' ? req.body.folder.trim() : ''
}

function normalizeCompanyName(company) {
  const normalized = getQueryParam(company).trim()
  if (!normalized) return ''
  return normalized.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()
}

function getCompanyConfig(company) {
  const normalizedCompany = normalizeCompanyName(company)
  const envNames = normalizedCompany
    ? {
        bucket: `R2_${normalizedCompany}_BUCKET`,
        accessKeyId: `R2_${normalizedCompany}_ACCESS_KEY_ID`,
        secretAccessKey: `R2_${normalizedCompany}_SECRET_ACCESS_KEY`,
        endpoint: `R2_${normalizedCompany}_ENDPOINT`,
        publicBaseUrl: `R2_${normalizedCompany}_PUBLIC_BASE_URL`,
        folder: `R2_${normalizedCompany}_FOLDER`,
      }
    : DEFAULT_ENV_NAMES

  const config = {
    bucket: env(envNames.bucket),
    accessKeyId: env(envNames.accessKeyId),
    secretAccessKey: env(envNames.secretAccessKey),
    endpoint: env(envNames.endpoint),
    publicBaseUrl: env(envNames.publicBaseUrl),
    folder: env(envNames.folder),
  }

  const missing = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([key]) => envNames[key])

  return {
    company: normalizedCompany,
    isDefault: !normalizedCompany,
    missing,
    config,
    envNames,
  }
}

function sanitizeExt(filename) {
  const dot = filename.lastIndexOf('.')
  if (dot === -1 || dot === filename.length - 1) return 'bin'
  const ext = filename.slice(dot + 1).toLowerCase()
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : 'bin'
}

function sanitizeFolder(folder) {
  const cleaned = (folder || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')

  return cleaned || 'uploads'
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const baseMissing = BASE_REQUIRED_VARS.filter((name) => !env(name))
  const provider = (env('STORAGE_PROVIDER') || '').toLowerCase()
  const companyParam = getCompanyParam(req)
  const folderParam = getFolderParam(req)
  const companyConfig = getCompanyConfig(companyParam)
  const missing = [...baseMissing, ...companyConfig.missing]

  // GET = diagnostic, dev/preview only. Disabled in production to avoid leaking
  // bucket/endpoint metadata to scrapers.
  if (req.method === 'GET') {
    if (IS_PRODUCTION) return res.status(404).json({ error: 'Not found' })
    return res.status(200).json({
      ok: missing.length === 0 && provider === 'r2',
      company: companyParam || null,
      requestedFolder: folderParam || null,
      normalizedCompany: companyConfig.company || null,
      usingDefaultConfig: companyConfig.isDefault,
      storageProvider: env('STORAGE_PROVIDER') ?? null,
      missing,
      expectedCompanyEnvVars: companyConfig.company
        ? COMPANY_REQUIRED_SUFFIXES.map((suffix) => `R2_${companyConfig.company}_${suffix}`)
        : Object.values(DEFAULT_ENV_NAMES),
      seen: [...BASE_REQUIRED_VARS, ...Object.values(companyConfig.envNames)].reduce((acc, name) => {
        const v = env(name)
        acc[name] = !v
          ? 'missing'
          : name.endsWith('SECRET_ACCESS_KEY') || name.endsWith('ACCESS_KEY_ID')
          ? `set (${v.length} chars)`
          : v
        return acc
      }, {}),
    })
  }

  if (missing.length > 0) {
    return res.status(500).json({
      error: companyConfig.isDefault
        ? `Missing default R2 configuration: ${missing.join(', ')}. Hit GET /api/presign for a diagnostic.`
        : `Missing configuration for company ${JSON.stringify(companyParam || null)}: ${missing.join(', ')}. Hit GET /api/presign?company=${encodeURIComponent(companyParam)} for a diagnostic.`,
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

  if (!contentType || typeof contentType !== 'string' || contentType.length > 255) {
    return res.status(400).json({ error: 'Invalid content type' })
  }

  try {
    const ext = sanitizeExt(filename)
    const folder = sanitizeFolder(folderParam || companyConfig.config.folder)
    const key = `${folder}/${Date.now()}-${randomUUID()}.${ext}`

    const command = new PutObjectCommand({
      Bucket: companyConfig.config.bucket,
      Key: key,
      ContentType: contentType,
    })

    const uploadUrl = await getSignedUrl(getClient(companyConfig.config), command, { expiresIn: 60 * 5 })
    const publicUrl = `${companyConfig.config.publicBaseUrl.replace(/\/$/, '')}/${key}`

    return res.status(200).json({ uploadUrl, publicUrl, key })
  } catch (err) {
    console.error('presign error', err)
    return res.status(500).json({ error: 'Failed to create presigned URL' })
  }
}
