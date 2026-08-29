import { lazy, Suspense, useEffect, useState } from 'react'
import { SiteApp, type SiteRoute } from './components/site/SiteApp'

const publicSiteOnly = import.meta.env.VITE_PUBLIC_SITE_ONLY === '1'
const designerOnly = import.meta.env.VITE_DESIGNER_ONLY === '1'
const websiteUrl = (import.meta.env.VITE_WEBSITE_URL as string | undefined)?.trim() || '/'
const DesignerApp = publicSiteOnly ? null : lazy(() => import('./components/designer/DesignerApp'))

const publicBase = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '')

const normalizeRoute = (pathname: string): SiteRoute => {
  const hasBase = publicBase && publicBase !== '/' && (pathname === publicBase || pathname.startsWith(`${publicBase}/`))
  const withoutBase = hasBase
    ? pathname.slice(publicBase.length) || '/'
    : pathname
  const route = withoutBase.replace(/\/+$/, '') || '/'
  if (route === '/design') return publicSiteOnly ? '/' : '/design'
  if (route === '/community') return '/community'
  if (route === '/guide') return '/guide'
  if (route === '/print') return '/print'
  if (route === '/project') return '/project'
  return '/'
}

function App() {
  const [route, setRoute] = useState<SiteRoute>(() => designerOnly ? '/design' : normalizeRoute(window.location.pathname))

  useEffect(() => {
    const onPopState = () => setRoute(normalizeRoute(window.location.pathname))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = (nextRoute: SiteRoute) => {
    const target = publicBase && publicBase !== '/'
      ? `${publicBase}${nextRoute === '/' ? '/' : nextRoute}`
      : nextRoute
    if (window.location.pathname !== target) window.history.pushState({}, '', target)
    setRoute(nextRoute)
  }

  if (designerOnly && DesignerApp) {
    return <Suspense fallback={<div className="designer-loading"><span>S</span><b>正在加载设计器……</b></div>}>
      <DesignerApp onBackHome={() => { window.location.href = websiteUrl }} />
    </Suspense>
  }

  if (route === '/design' && !publicSiteOnly && DesignerApp) {
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
