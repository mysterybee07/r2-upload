function env(name) {
  const v = process.env[name]
  return typeof v === 'string' ? v.trim() : v
}

function formatCompanyLabel(company) {
  return company
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(' ')
}

function getAvailableCompanies() {
  return Object.keys(process.env)
    .filter((name) => /^R2_[A-Z0-9_]+_BUCKET$/.test(name) && name !== 'R2_BUCKET' && env(name))
    .map((name) => name.slice(3, -7))
    .sort()
    .map((company) => ({
      value: company.toLowerCase(),
      label: formatCompanyLabel(company),
    }))
}

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  return res.status(200).json({
    companies: getAvailableCompanies(),
  })
}
