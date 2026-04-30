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

const CUSTOM_COMPANY_OPTION = '__custom__'

export default function App() {
  const initialCompany = getCompanyFromQuery()
  const [folder, setFolder] = useState('')
  const [companyOptions, setCompanyOptions] = useState([])
  const [files, setFiles] = useState([])
  const [status, setStatus] = useState('idle')
  const [progress, setProgress] = useState(0)
  const [uploadedFiles, setUploadedFiles] = useState([])
  const [error, setError] = useState('')
  const [customCompany, setCustomCompany] = useState(initialCompany)
  const [selectedCompany, setSelectedCompany] = useState(initialCompany || '')
  const [compressEnabled, setCompressEnabled] = useState(true)
  const [outputFormat, setOutputFormat] = useState('webp')
  const [maxDimension, setMaxDimension] = useState(DEFAULT_MAX_DIMENSION)
  const [stats, setStats] = useState([])
  const [copiedUrl, setCopiedUrl] = useState('')

  const company = selectedCompany === CUSTOM_COMPANY_OPTION ? customCompany.trim() : selectedCompany
  const storageOptions = [
    { value: '', label: 'Default' },
    ...companyOptions,
    { value: CUSTOM_COMPANY_OPTION, label: 'Custom' },
  ]

  useEffect(() => {
    const latestUrl = uploadedFiles.at(-1)?.publicUrl
    if (!latestUrl) return

    copyToClipboard(latestUrl).then((ok) => {
      if (ok) {
        setCopiedUrl(latestUrl)
        const t = setTimeout(() => setCopiedUrl(''), 1500)
        return () => clearTimeout(t)
      }
    })
  }, [uploadedFiles])

  useEffect(() => {
    let cancelled = false

    fetch('/api/companies')
      .then((res) => {
        if (!res.ok) throw new Error(`Company list failed (${res.status})`)
        return res.json()
      })
      .then((data) => {
        if (cancelled) return
        setCompanyOptions(Array.isArray(data.companies) ? data.companies : [])
      })
      .catch(() => {
        if (cancelled) return
        setCompanyOptions([])
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!initialCompany) return

    const matched = companyOptions.find(
      (opt) => opt.value.toLowerCase() === initialCompany.toLowerCase(),
    )

    if (matched) {
      setSelectedCompany(matched.value)
      setCustomCompany('')
      return
    }

    setSelectedCompany(CUSTOM_COMPANY_OPTION)
    setCustomCompany(initialCompany)
  }, [companyOptions, initialCompany])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (company) url.searchParams.set('company', company)
    else url.searchParams.delete('company')
    window.history.replaceState({}, '', url)
  }, [company])

  async function onCopyClick(text) {
    const ok = await copyToClipboard(text)
    if (ok) {
      setCopiedUrl(text)
      setTimeout(() => setCopiedUrl(''), 1500)
    }
  }

  function onFileChange(e) {
    const nextFiles = Array.from(e.target.files || [])
    if (nextFiles.length === 0) return

    setFiles(nextFiles)
    setUploadedFiles([])
    setError('')
    setProgress(0)
    setStats([])
    setStatus('idle')
  }

  async function onUpload() {
    if (files.length === 0) return

    setError('')
    setProgress(0)
    setStats([])
    setUploadedFiles([])

    try {
      const uploaded = []
      const collectedStats = []

      for (const [index, file] of files.entries()) {
        let toUpload = file

        if (compressEnabled && COMPRESSIBLE_TYPES.includes(file.type)) {
          setStatus('compressing')
          toUpload = await compress(file, { maxDimension, outputFormat })
          collectedStats.push({
            name: file.name,
            originalBytes: file.size,
            compressedBytes: toUpload.size,
            originalType: file.type,
            finalType: toUpload.type,
          })
          setStats([...collectedStats])
        }

        setStatus('presigning')
        const presignUrl = company ? `/api/presign?company=${encodeURIComponent(company)}` : '/api/presign'
        const presignRes = await fetch(presignUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            company,
            folder,
            filename: toUpload.name,
            contentType: toUpload.type || 'application/octet-stream',
          }),
        })

        if (!presignRes.ok) {
          const body = await presignRes.json().catch(() => ({}))
          throw new Error(body.error || `Presign failed (${presignRes.status})`)
        }

        const { uploadUrl, publicUrl, key } = await presignRes.json()

        setStatus('uploading')
        await uploadWithProgress(uploadUrl, toUpload, (fileProgress) => {
          const overall = ((index + fileProgress / 100) / files.length) * 100
          setProgress(Math.round(overall))
        })

        uploaded.push({
          name: toUpload.name,
          publicUrl,
          key,
          contentType: toUpload.type || 'application/octet-stream',
        })
        setUploadedFiles([...uploaded])
      }

      setProgress(100)
      setStatus('done')
    } catch (err) {
      setError(err.message || String(err))
      setStatus('error')
    }
  }

  const busy = status === 'uploading' || status === 'presigning' || status === 'compressing'
  const imagePreviews = files.filter((file) => file.type?.startsWith('image/')).slice(0, 4)

  return (
    <main className="container">
      <h1>R2 File Upload</h1>
      <p className="muted">Pick one or more files, upload them to Cloudflare R2, and get public URLs.</p>

      <div className="card">
        <fieldset className="settings" disabled={busy}>
          <legend>Storage</legend>

          <label className="row">
            <span>Company</span>
            <select
              value={selectedCompany}
              onChange={(e) => setSelectedCompany(e.target.value)}
              className="select"
            >
              {storageOptions.map((opt) => (
                <option key={opt.value || 'default'} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          {selectedCompany === CUSTOM_COMPANY_OPTION && (
            <label className="row">
              <span>Custom name</span>
              <input
                type="text"
                value={customCompany}
                onChange={(e) => setCustomCompany(e.target.value)}
                placeholder="Enter company"
                className="text-input"
              />
            </label>
          )}

          <label className="row">
            <span>Folder</span>
            <input
              type="text"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="Leave empty to use env default"
              className="text-input"
            />
          </label>

          <p className="hint">
            {company
              ? `Uploads will use the ${company} R2 configuration${folder.trim() ? ` and folder ${folder.trim()}.` : '.'}`
              : `Uploads will use the default R2 configuration${folder.trim() ? ` and folder ${folder.trim()}.` : '.'}`}
          </p>
        </fieldset>

        <input type="file" multiple onChange={onFileChange} disabled={busy} />

        {files.length > 0 && (
          <div className="selection">
            <span className="selection-label">
              {files.length} file{files.length === 1 ? '' : 's'} selected
            </span>
            <div className="selection-list">
              {files.map((file) => (
                <div key={`${file.name}-${file.size}-${file.lastModified}`} className="selection-item">
                  <span className="selection-name">{file.name}</span>
                  <span className="muted small">{formatBytes(file.size)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {imagePreviews.length > 0 && (
          <div className="preview-grid">
            {imagePreviews.map((file) => (
              <div key={`${file.name}-${file.lastModified}`} className="preview">
                <img src={URL.createObjectURL(file)} alt={file.name} />
              </div>
            ))}
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
            <span>Compress images before upload</span>
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

        <button className="primary" onClick={onUpload} disabled={files.length === 0 || busy}>
          {status === 'compressing'
            ? 'Compressing...'
            : status === 'uploading'
            ? `Uploading... ${progress}%`
            : status === 'presigning'
            ? 'Preparing...'
            : `Upload ${files.length || ''} ${files.length === 1 ? 'file' : 'files'} to R2`}
        </button>

        {(status === 'uploading' || (status === 'done' && progress > 0)) && (
          <div className="progress">
            <div style={{ width: `${progress}%` }} />
          </div>
        )}

        {stats.length > 0 && (
          <div className="stats-list">
            {stats.map((stat) => (
              <p key={stat.name} className="muted small">
                {stat.name}: {formatBytes(stat.originalBytes)} {'->'} {formatBytes(stat.compressedBytes)} (
                {savedPct(stat.originalBytes, stat.compressedBytes)}% smaller
                {stat.originalType !== stat.finalType ? `, ${stat.finalType.replace('image/', '')}` : ''})
              </p>
            ))}
          </div>
        )}

        {error && <p className="error">{error}</p>}

        {uploadedFiles.length > 0 && (
          <div className="result">
            <div className="result-head">
              <span className="result-label">
                Uploaded {uploadedFiles.length} file{uploadedFiles.length === 1 ? '' : 's'}
              </span>
            </div>
            {uploadedFiles.map((item) => (
              <div key={item.publicUrl} className="result-url">
                <div className="result-meta">
                  <span className="selection-name">{item.name}</span>
                  <a href={item.publicUrl} target="_blank" rel="noreferrer" title={item.publicUrl}>
                    {item.publicUrl}
                  </a>
                </div>
                <button
                  type="button"
                  className="copy-btn"
                  onClick={() => onCopyClick(item.publicUrl)}
                  aria-label={copiedUrl === item.publicUrl ? 'Copied' : 'Copy URL'}
                  title={copiedUrl === item.publicUrl ? 'Copied' : 'Copy URL'}
                >
                  {copiedUrl === item.publicUrl ? <CheckIcon /> : <CopyIcon />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}

function getCompanyFromQuery() {
  if (typeof window === 'undefined') return ''
  return new URLSearchParams(window.location.search).get('company')?.trim() || ''
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }

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
  const opt = FORMAT_OPTIONS.find((o) => o.value === outputFormat)
  const targetMime = opt?.mime || file.type
  const targetExt = opt?.ext || null

  const options = {
    maxWidthOrHeight: maxDimension,
    useWebWorker: true,
    initialQuality: QUALITY,
    fileType: targetMime,
    maxSizeMB: 10,
  }

  const compressed = await imageCompression(file, options)

  if (compressed.size >= file.size && compressed.type === file.type && !targetExt) {
    return file
  }

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
