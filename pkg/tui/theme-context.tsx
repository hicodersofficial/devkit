// Theme context — provides the active Theme to every screen and a `cycle()` to
// switch it. The choice is loaded from and saved to ~/.devkit.json, so it sticks
// across runs and across tools. Components read colors via useTheme(); the
// shared ListSelect calls useThemeControls().cycle() on the `t` key.

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { defaultTheme, nextTheme, themeByName, type Theme } from "./theme";
import { loadConfig, saveConfig } from "../core/config";

interface ThemeControls {
  theme: Theme;
  cycle: () => void;
}

const ThemeCtx = createContext<ThemeControls>({ theme: defaultTheme, cycle: () => {} });

export const useTheme = (): Theme => useContext(ThemeCtx).theme;
export const useThemeControls = (): ThemeControls => useContext(ThemeCtx);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => themeByName(loadConfig().theme));
  const cycle = useCallback(() => {
    setTheme((cur) => {
      const next = nextTheme(cur.name);
      saveConfig({ theme: next.name });
      return next;
    });
  }, []);
  return <ThemeCtx.Provider value={{ theme, cycle }}>{children}</ThemeCtx.Provider>;
}
