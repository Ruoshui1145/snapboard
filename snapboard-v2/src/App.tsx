import { lazy, Suspense, useEffect, useState } from 'react'
import { SiteApp, type SiteRoute } from './components/site/SiteApp'

const DesignerApp = lazy(() => import('./components/designer/DesignerApp'))

const normalizeRoute = (pathname: string): SiteRoute => {
  if (pathname === '/design') return '/design'
  if (pathname === '/community') return '/community'
  if (pathname === '/guide') return '/guide'
  if (pathname === '/print') return '/print'
  return '/'
}

function App() {
  const [route, setRoute] = useState<SiteRoute>(() => normalizeRoute(window.location.pathname))

  useEffect(() => {
    const onPopState = () => setRoute(normalizeRoute(window.location.pathname))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = (nextRoute: SiteRoute) => {
    if (window.location.pathname !== nextRoute) window.history.pushState({}, '', nextRoute)
    setRoute(nextRoute)
  }

  if (route === '/design') {
    return (
      <>
        <Suspense fallback={<div className="designer-loading"><span>S</span><b>正在加载设计器……</b></div>}>
          <DesignerApp onBackHome={() => navigate('/')} />
        </Suspense>
      </>
    )
  }

  return <SiteApp route={route} navigate={navigate} />
}

export default App
