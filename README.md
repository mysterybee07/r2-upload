# R2 Upload

A React + Vite frontend that uploads images to a Cloudflare R2 bucket and returns a public URL. Images are compressed in the browser (auto-EXIF-orient, max-dimension cap, optional WebP) before upload. A small Vercel serverless function (`/api/presign`) signs a short-lived PUT URL so R2 credentials never reach the browser.

## How it works

```
browser ──► POST /api/presign        ──► returns { uploadUrl, publicUrl }
browser ──► PUT compressed file → uploadUrl   (direct to R2)
browser ──► renders publicUrl
```

In **local development**, a small Vite plugin in `vite.config.js` mounts everything in `/api/` as middleware on the dev server — so `npm run dev` Just Works without the Vercel CLI. In **production**, the same `/api/presign.js` file is picked up by Vercel's serverless runtime exactly as it would be normally.

## Prerequisites

- Node.js 18+
- A Cloudflare R2 bucket with **Public Access** enabled (or a custom domain bound to it)
- An R2 API token with read/write access to that bucket
- A Vercel account (only required when you deploy)

## Quick start (local)

```bash
# 1. install
npm install

# 2. configure env
cp .env.example .env.local
# then open .env.local and fill in the 7 values (see table below)

# 3. configure CORS on the R2 bucket — see "R2 bucket CORS" section below

# 4. run
npm run dev
# open http://localhost:5173
```

That's it. No `vercel link`, no `vercel dev`, no `.vercel/` folder needed locally.

## Environment variables

Copy `.env.example` → `.env.local` and fill in:

| Variable | Example | Notes |
|---|---|---|
| `STORAGE_PROVIDER` | `r2` | Must be the literal string `r2`. |
| `R2_BUCKET` | `default-bucket` | Default bucket used when `company` is not provided. |
| `R2_ACCESS_KEY_ID` | `…` | Default R2 access key. |
| `R2_SECRET_ACCESS_KEY` | `…` | Default R2 secret key. |
| `R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` | Default S3-compatible endpoint. |
| `R2_PUBLIC_BASE_URL` | `https://pub-xxx.r2.dev` or `https://cdn.example.com` | Default public base URL. |
| `R2_FOLDER` | `uploads` | Default folder/prefix for created object keys. |
| `R2_<COMPANY>_BUCKET` | `my-bucket` | Bucket name for that company. |
| `R2_<COMPANY>_ACCESS_KEY_ID` | `…` | From R2 → Manage R2 API Tokens. |
| `R2_<COMPANY>_SECRET_ACCESS_KEY` | `…` | From R2 → Manage R2 API Tokens. |
| `R2_<COMPANY>_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` | S3-compatible endpoint for that company. |
| `R2_<COMPANY>_PUBLIC_BASE_URL` | `https://pub-xxx.r2.dev` or `https://cdn.example.com` | Used to build the returned public URL. No trailing slash needed. |
| `R2_<COMPANY>_FOLDER` | `uploads/moneymitra` | Folder/prefix for that company's object keys. |

`<COMPANY>` comes from the page query string. Example: opening the app with `?company=acme`
will make `/api/presign` read `R2_ACME_BUCKET`, `R2_ACME_ACCESS_KEY_ID`, and the rest of the
`R2_ACME_*` variables. Company names are normalized to uppercase with non-alphanumeric
characters converted to `_`, so `?company=foo-bar` maps to `R2_FOO_BAR_*`. Case does not matter:
`moneymitra`, `MoneyMitra`, and `MONEYMITRA` all resolve to `R2_MONEYMITRA_*`. If no `company`
is provided, the API falls back to the default `R2_*` variables. The object key prefix also comes
from env via `R2_FOLDER` or `R2_<COMPANY>_FOLDER`. If the frontend sends a `folder` value in the
upload request body, that folder is used instead of the env default.

The frontend company dropdown is populated from server env, so only companies that actually have
an `R2_<COMPANY>_BUCKET` value configured are shown as options.

**Never put real values in `.env.example`.** The pre-commit hook (see below) will block any commit that does.

## R2 bucket CORS

R2 buckets reject browser uploads by default. Add a CORS policy in the Cloudflare dashboard: **R2 → your bucket → Settings → CORS Policy**:

```json
[
  {
    "AllowedOrigins": [
      "http://localhost:5173",
      "https://your-app.vercel.app"
    ],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Add every origin you'll upload from. CORS changes propagate within a few seconds.

## Diagnostic endpoint

`GET /api/presign` returns a sanity-check JSON of what env vars the function actually sees (with secrets masked):

```bash
curl http://localhost:5173/api/presign
```

Expect `{ "ok": true, "missing": [], … }`. If `ok: false`, the response tells you which variables are missing or wrong.

This endpoint is **disabled in production** (`VERCEL_ENV === 'production'` returns 404).

## Deploy to Vercel

1. Push the repo to GitHub.
2. In Vercel: **Add New… → Project → Import** the repo. Framework preset auto-detects as **Vite**.
3. Under **Settings → Environment Variables**, add the 7 variables from the table above. Set them for **Production**, **Preview**, and **Development**.
4. Click **Deploy**.
5. After the first deploy, add the production URL to your R2 bucket's CORS `AllowedOrigins`.

CLI alternative:

```bash
npx vercel        # preview deploy
npx vercel --prod # production deploy
```

If you want to pull the deployed env vars back to your machine:

```bash
npx vercel env pull .env.local
```

## Project structure

```
r2-upload/
├── api/
│   └── presign.js              # Vercel serverless function
├── scripts/
│   └── check-secrets.mjs       # Pre-commit secret scanner
├── src/
│   ├── App.jsx                 # React UI + image compression
│   ├── App.css
│   └── main.jsx
├── .husky/
│   └── pre-commit              # Runs check-secrets.mjs
├── index.html
├── vite.config.js              # Includes dev plugin that serves /api/*
├── vercel.json
├── .env.example
└── package.json
```

## Image compression

Uses [`browser-image-compression`](https://github.com/Donaldcwl/browser-image-compression) running in a Web Worker. Defaults:

- **Max dimension**: 1600px (configurable in the UI; aspect ratio preserved)
- **Quality**: 0.85 (visually lossless for photos)
- **Output format**: WebP if the source is JPEG or PNG (toggleable)
- **EXIF orientation**: applied to the canvas, so output is correctly rotated
- **No sharpening or contrast adjustment** — explicit choice to avoid degrading images

If WebP conversion makes a file larger than the original (rare, on tiny PNGs), the original is uploaded instead.

## Pre-commit secret protection

Husky runs `scripts/check-secrets.mjs` before every commit. It blocks:

- Any `.env*` file other than `.env.example`
- A `.env.example` that contains real (non-placeholder) values
- Hardcoded credential assignments in source (`R2_*`, `AWS_*`, `OPENAI_API_KEY`, `STRIPE_*`, `JWT_SECRET`, `DATABASE_URL`, etc.)

Run it manually anytime:

```bash
npm run check:secrets
```

If it ever blocks a legitimate commit, bypass with `git commit --no-verify` — but read the message first.

## NPM scripts

| Script | What it does |
|---|---|
| `npm run dev` | Starts Vite on http://localhost:5173 with `/api/*` mounted. |
| `npm run build` | Production build → `dist/`. |
| `npm run preview` | Serves the production build locally (no `/api/*`). |
| `npm run check:secrets` | Runs the pre-commit secret scanner against staged files. |

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| `Presign failed (404)` | You're hitting a server that doesn't serve `/api/*`. Use `npm run dev` (not `vite preview`); for production, ensure `api/presign.js` is at the project root. |
| `Missing env vars: …` | `.env.local` not loaded. Confirm the file is at the project root, named exactly `.env.local` (no `.txt` extension), and restart `npm run dev`. |
| `Network error during upload` | Almost always missing CORS on the R2 bucket. Open DevTools Console for the exact CORS message; add your origin to the bucket's CORS policy. |
| `403 Forbidden` from R2 | The R2 access token doesn't have write permission on the bucket, or it's scoped to a different bucket. |
| Public URL returns 404 | Bucket doesn't have Public Access enabled, or `R2_PUBLIC_BASE_URL` doesn't match the bucket's public domain. |
| Uploaded file has a wrong content type | Browser failed to detect the image's MIME type. Make sure you're uploading a real image file. |

For anything else, hit `GET /api/presign` (in dev) and paste the JSON output — that pinpoints env / config problems instantly.
