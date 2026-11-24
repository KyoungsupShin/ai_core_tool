import { useEffect, useState } from 'react'

const initialEstimate = {
  foundationModels: [{
    modelId: 'gpt4.1mini', version: '2025-04-14', pricingMode: 'Standard',
    usage: { inputTokensPerRequest: 2000, outputTokensPerRequest: 500, requestsPerMonth: 10000 },
  }],
}

async function request(path, options) {
  const response = await fetch(path, options)
  const body = await response.json()
  if (!response.ok) throw new Error(body.error?.message || '요청을 처리하지 못했습니다.')
  return body
}

export default function App() {
  const [query, setQuery] = useState('gpt-4.1')
  const [models, setModels] = useState([])
  const [estimateText, setEstimateText] = useState(JSON.stringify(initialEstimate, null, 2))
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const searchModels = async () => {
    setLoading(true); setError('')
    try { setModels((await request(`/api/models/?query=${encodeURIComponent(query)}`)).models) }
    catch (e) { setError(e.message) } finally { setLoading(false) }
  }
  useEffect(() => { searchModels() }, [])

  const estimate = async (event) => {
    event.preventDefault(); setLoading(true); setError(''); setResult(null)
    try {
      const payload = JSON.parse(estimateText)
      setResult(await request('/api/estimates/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }))
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }

  return <main>
    <header><p>Joule4Sales</p><h1>SAP AI Core 비용 견적 도구</h1><span>React · Django API</span></header>
    {error && <div className="error">{error}</div>}
    <section><h2>모델 검색</h2><div className="row"><input value={query} onChange={e => setQuery(e.target.value)} placeholder="모델명" /><button onClick={searchModels} disabled={loading}>검색</button></div>
      <ul>{models.slice(0, 10).map(model => <li key={model.modelId}><strong>{model.name}</strong> <code>{model.modelId}</code><small>{model.versions.map(v => v.version).join(', ')}</small></li>)}</ul>
    </section>
    <section><h2>월간 견적</h2><p>가격 산출 입력을 JSON으로 작성하세요. 토큰은 요청당, 요청 수는 월간 기준입니다.</p><form onSubmit={estimate}><textarea value={estimateText} onChange={e => setEstimateText(e.target.value)} spellCheck="false" /><button type="submit" disabled={loading}>{loading ? '계산 중…' : '견적 계산'}</button></form>
      {result && <div className="result"><h3>{result.monthlyCUExact} CU / month</h3><p>가격표: {result.pricingVersion}</p><pre>{JSON.stringify(result.breakdown, null, 2)}</pre></div>}
    </section>
  </main>
}
