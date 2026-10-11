import { createContext, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { translateUiText, type AppLocale } from './catalog'

const STORAGE_KEY = 'snapboard-ui-language'

interface I18nContextValue {
  locale: AppLocale
  setLocale: (locale: AppLocale) => void
  toggleLocale: () => void
  t: (source: string) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

const readLocale = (): AppLocale => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'en-US' || saved === 'zh-CN') return saved
  } catch { /* private browsing / SSR */ }
  return 'zh-CN'
}

const TRANSLATABLE_ATTRIBUTES = ['title', 'aria-label', 'placeholder', 'alt'] as const
const originalText = new WeakMap<Text, string>()
const appliedText = new WeakMap<Text, string>()
const originalAttributes = new WeakMap<Element, Map<string, string>>()
const appliedAttributes = new WeakMap<Element, Map<string, string>>()

const isIgnored = (node: Node) => {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
  return Boolean(element?.closest('[data-i18n-ignore="true"], script, style, canvas'))
}

const translateTextNode = (node: Text, locale: AppLocale) => {
  if (isIgnored(node)) return
  const current = node.nodeValue ?? ''
  if (appliedText.get(node) !== current) originalText.set(node, current)
  const original = originalText.get(node) ?? current
  const translated = translateUiText(locale, original)
  appliedText.set(node, translated)
  if (translated !== current) node.nodeValue = translated
}

const translateElementAttributes = (element: Element, locale: AppLocale) => {
  if (isIgnored(element)) return
  let originals = originalAttributes.get(element)
  let applied = appliedAttributes.get(element)
  if (!originals) { originals = new Map(); originalAttributes.set(element, originals) }
  if (!applied) { applied = new Map(); appliedAttributes.set(element, applied) }
  for (const attribute of TRANSLATABLE_ATTRIBUTES) {
    const current = element.getAttribute(attribute)
    if (current === null) continue
    if (applied.get(attribute) !== current) originals.set(attribute, current)
    const original = originals.get(attribute) ?? current
    const translated = translateUiText(locale, original)
    applied.set(attribute, translated)
    if (translated !== current) element.setAttribute(attribute, translated)
  }
}

const translateTree = (root: Node, locale: AppLocale) => {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root as Text, locale)
    return
  }
  if (root.nodeType !== Node.ELEMENT_NODE || isIgnored(root)) return
  translateElementAttributes(root as Element, locale)
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) translateTextNode(node as Text, locale)
    else translateElementAttributes(node as Element, locale)
    node = walker.nextNode()
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(readLocale)
  const setLocale = (next: AppLocale) => {
    setLocaleState(next)
    try { localStorage.setItem(STORAGE_KEY, next) } catch { /* ignore */ }
  }
  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale,
    toggleLocale: () => setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN'),
    t: source => translateUiText(locale, source),
  }), [locale])

  useLayoutEffect(() => {
    document.documentElement.lang = locale
    // Dialogs such as preview, calibration and settings are React portals mounted
    // directly under body, so the localization surface must include more than #root.
    const root = document.body
    if (!root) return
    translateTree(root, locale)
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'characterData') translateTree(record.target, locale)
        else if (record.type === 'attributes') translateElementAttributes(record.target as Element, locale)
        else record.addedNodes.forEach(node => translateTree(node, locale))
      }
    })
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...TRANSLATABLE_ATTRIBUTES],
    })
    return () => observer.disconnect()
  }, [locale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const value = useContext(I18nContext)
  if (!value) throw new Error('useI18n must be used within I18nProvider')
  return value
}
