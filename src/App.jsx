import { useEffect, useState } from 'react'
import imageCompression from 'browser-image-compression'

const DEFAULT_MAX_DIMENSION = 1600
const QUALITY = 0.85
const COMPRESSIBLE_TYPES = ['image/jpeg', 'image/png', 'image/webp']

const FORMAT_OPTIONS = [
  { value: 'original', label: 'Keep original', mime: null, ext: null },
  { value: 'jpg', label: 'JPG', mime: 'image/jpeg', ext: 'jpg' },
  { value: 'jpeg', label: 'JPEG', mime: 'image/jpeg', ext: 'jpeg' },
  { value: 'png', label: 'PNG', mime: 'image/png', ext: 'png' },
  { value: 'webp', label: 'WebP', mime: 'image/webp', ext: 'webp' },
]

export default function App() {
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [status, setStatus] = useState('idle')
  const [progress, setProgress] = useState(0)
  const [uploadedUrl, setUploadedUrl] = useState('')
  const [error, setError] = useState('')

  const [compressEnabled, setCompressEnabled] = useState(true)
  const [outputFormat, setOutputFormat] = useState('webp')
  const [maxDimension, setMaxDimension] = useState(DEFAULT_MAX_DIMENSION)
  const [stats, setStats] = useState(null)
  const [copied, setCopied] = useState(false)

  // Auto-copy the public URL the moment an upload completes.
  useEffect(() => {
    if (!uploadedUrl) return
    copyToClipboard(uploadedUrl).then((ok) => {
      if (ok) {
        setCopied(true)
        const t = setTimeout(() => setCopied(false), 1500)
        return () => clearTimeout(t)
      }
    })
  }, [uploadedUrl])

  async function onCopyClick() {
    const ok = await copyToClipboard(uploadedUrl)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  function onFileChange(e) {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
    setUploadedUrl('')
    setError('')
    setProgress(0)
    setStats(null)
    setStatus('idle')
    setPreview(URL.createObjectURL(f))
  }

  async function onUpload() {
    if (!file) return
    setError('')
    setProgress(0)
    setStats(null)

    try {
      let toUpload = file

      if (compressEnabled && COMPRESSIBLE_TYPES.includes(file.type)) {
        setStatus('compressing')
        toUpload = await compress(file, { maxDimension, outputFormat })

        setStats({
          originalBytes: file.size,
          compressedBytes: toUpload.size,
          originalType: file.type,
          finalType: toUpload.type,
        })
      }

      setStatus('presigning')
      const presignRes = await fetch('/api/presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: toUpload.name,
          contentType: toUpload.type || 'application/octet-stream',
        }),
      })

      if (!presignRes.ok) {
        const body = await presignRes.json().catch(() => ({}))
        throw new Error(body.error || `Presign failed (${presignRes.status})`)
      }

      const { uploadUrl, publicUrl } = await presignRes.json()

      setStatus('uploading')
      await uploadWithProgress(uploadUrl, toUpload, setProgress)

      setUploadedUrl(publicUrl)
      setStatus('done')
    } catch (err) {
      setError(err.message || String(err))
      setStatus('error')
    }
  }

  const busy = status === 'uploading' || status === 'presigning' || status === 'compressing'

  return (
    <main className="container">
      <h1>R2 Image Upload</h1>
      <p className="muted">Pick an image, upload it to Cloudflare R2, and get a public URL.</p>

      <div className="card">
        <input type="file" accept="image/*" onChange={onFileChange} disabled={busy} />

        {preview && (
          <div className="preview">
            <img src={preview} alt="preview" />
          </div>
        )}

        <fieldset className="settings" disabled={busy}>
          <legend>Compression</legend>

          <label className="row">
            <input
              type="checkbox"
              checked={compressEnabled}
              onChange={(e) => setCompressEnabled(e.target.checked)}
            />
            <span>Compress before upload</span>
          </label>

          <label className="row">
            <span>Output format</span>
            <select
              value={outputFormat}
              onChange={(e) => setOutputFormat(e.target.value)}
              disabled={!compressEnabled}
              className="select"
            >
              {FORMAT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <label className="row">
            <span>Max width/height</span>
            <input
              type="number"
              min={256}
              max={8192}
              step={64}
              value={maxDimension}
              onChange={(e) => setMaxDimension(Number(e.target.value) || DEFAULT_MAX_DIMENSION)}
              disabled={!compressEnabled}
              className="num"
            />
            <span className="muted">px</span>
          </label>
        </fieldset>

        <button className="primary" onClick={onUpload} disabled={!file || busy}>
          {status === 'compressing'
            ? 'Compressing…'
            : status === 'uploading'
            ? `Uploading… ${progress}%`
            : status === 'presigning'
            ? 'Preparing…'
            : 'Upload to R2'}
        </button>

        {(status === 'uploading' || (status === 'done' && progress > 0)) && (
          <div className="progress">
            <div style={{ width: `${progress}%` }} />
          </div>
        )}

        {stats && (
          <p className="muted small">
            {formatBytes(stats.originalBytes)} → {formatBytes(stats.compressedBytes)} (
            {savedPct(stats.originalBytes, stats.compressedBytes)}% smaller
            {stats.originalType !== stats.finalType ? `, ${stats.finalType.replace('image/', '')}` : ''})
          </p>
        )}

        {error && <p className="error">{error}</p>}

        {uploadedUrl && (
          <div className="result">
            <div className="result-head">
              <span className="result-label">Uploaded {copied ? '· copied to clipboard' : ''}</span>
            </div>
            <div className="result-url">
              <a href={uploadedUrl} target="_blank" rel="noreferrer" title={uploadedUrl}>
                {uploadedUrl}
              </a>
              <button
                type="button"
                className="copy-btn"
                onClick={onCopyClick}
                aria-label={copied ? 'Copied' : 'Copy URL'}
                title={copied ? 'Copied' : 'Copy URL'}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
    // Fallback for non-secure contexts (e.g. plain http on a remote dev machine)
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

async function compress(file, { maxDimension, outputFormat }) {
  // browser-image-compression auto-orients via EXIF when drawing to canvas,
  // preserves aspect ratio when given maxWidthOrHeight, and runs off the main thread.
  const opt = FORMAT_OPTIONS.find((o) => o.value === outputFormat)
  const targetMime = opt?.mime || file.type
  const targetExt = opt?.ext || null

  const options = {
    maxWidthOrHeight: maxDimension,
    useWebWorker: true,
    initialQuality: QUALITY,
    fileType: targetMime,
    // High ceiling — let dimension + quality drive the result, not aggressive size targeting.
    maxSizeMB: 10,
  }

  const compressed = await imageCompression(file, options)

  // If compression made the file bigger (rare, e.g. tiny PNG → WebP overhead) and the user
  // didn't ask for a different format, keep the original.
  if (compressed.size >= file.size && compressed.type === file.type && !targetExt) {
    return file
  }

  // Rename so the extension matches the final mime type (or the user's chosen extension).
  const newName = renameForType(file.name, compressed.type, targetExt)
  return new File([compressed], newName, { type: compressed.type, lastModified: Date.now() })
}

function renameForType(name, mime, preferredExt) {
  const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
  const ext = preferredExt || extMap[mime]
  if (!ext) return name
  const base = name.replace(/\.[^./\\]+$/, '')
  return `${base}.${ext}`
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function savedPct(before, after) {
  if (before === 0) return 0
  return Math.max(0, Math.round((1 - after / before) * 100))
}

function uploadWithProgress(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url, true)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`Upload failed (${xhr.status}): ${xhr.responseText}`))
    }
    xhr.onerror = () => reject(new Error('Network error during upload'))
    xhr.send(file)
  })
}
