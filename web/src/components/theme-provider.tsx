import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react'

type Theme = 'dark' | 'light' | 'system'

type ThemeProviderProps = {
  children: ReactNode
  defaultTheme?: Theme
  storageKey?: string
}

type ThemeContextValue = {
  theme: Theme
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  storageKey = 'bud-ui-theme',
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(defaultTheme)

  useEffect(() => {
    const stored = window.localStorage.getItem(storageKey) as Theme | null
    if (stored) {
      setTheme(stored)
    }
  }, [storageKey])

  useEffect(() => {
    const root = document.documentElement
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    const applyThemeClass = (nextTheme: Theme) => {
      root.classList.remove('light', 'dark')

      if (nextTheme === 'system') {
        root.classList.add(mediaQuery.matches ? 'dark' : 'light')
        return
      }

      root.classList.add(nextTheme)
    }

    applyThemeClass(theme)

    if (theme !== 'system') {
      return
    }

    const handleChange = () => {
      applyThemeClass('system')
    }

    mediaQuery.addEventListener('change', handleChange)
    return () => {
      mediaQuery.removeEventListener('change', handleChange)
    }
  }, [theme])

  const value = useMemo(
    () => ({
      theme,
      setTheme: (next: Theme) => {
        window.localStorage.setItem(storageKey, next)
        setTheme(next)
      },
    }),
    [theme, storageKey]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) {
    throw new Error('useTheme must be used within ThemeProvider')
  }
  return ctx
}
