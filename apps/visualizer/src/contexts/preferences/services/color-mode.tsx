import {
  type Accessor,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type ParentProps,
  useContext,
} from "solid-js";

const COLOR_MODE_COOKIE_KEY = "zaidan-color-mode";

export type ColorMode = "light" | "dark" | "system";
type ResolvedColorMode = Exclude<ColorMode, "system">;

type ColorModeContextValue = {
  colorMode: Accessor<ColorMode>;
  resolvedColorMode: Accessor<ResolvedColorMode>;
  setColorMode: (mode: ColorMode) => void;
};

const ColorModeContext = createContext<ColorModeContextValue>();

const getSystemColorMode = (): ResolvedColorMode => {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

const isColorMode = (value: string | undefined): value is ColorMode =>
  value === "light" || value === "dark" || value === "system";

const getStoredColorMode = () => {
  if (typeof document === "undefined") return undefined;

  return document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith(`${COLOR_MODE_COOKIE_KEY}=`))
    ?.split("=")[1];
};

export function ColorModeProvider(
  props: ParentProps<{
    initialColorMode: ColorMode;
  }>,
) {
  const [colorMode, setColorMode] = createSignal<ColorMode>(props.initialColorMode);
  const [systemColorMode, setSystemColorMode] = createSignal<ResolvedColorMode>(
    getSystemColorMode(),
  );
  const resolvedColorMode = createMemo<ResolvedColorMode>(() => {
    const mode = colorMode();
    return mode === "system" ? systemColorMode() : mode;
  });

  createEffect(() => {
    const mode = colorMode();
    const resolved = resolvedColorMode();
    const html = document.documentElement;

    html.classList.remove("light", "dark");
    html.classList.add(resolved);
    html.style.colorScheme = resolved;

    // biome-ignore lint/suspicious/noDocumentCookie: the color mode must also survive reloads
    document.cookie = `${COLOR_MODE_COOKIE_KEY}=${mode}; path=/; max-age=31536000; SameSite=Lax`;
  });

  createEffect(() => {
    if (colorMode() !== "system") return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemColorMode(getSystemColorMode());

    media.addEventListener("change", onChange);
    onCleanup(() => media.removeEventListener("change", onChange));
  });

  return (
    <ColorModeContext.Provider value={{ colorMode, resolvedColorMode, setColorMode }}>
      {props.children}
    </ColorModeContext.Provider>
  );
}

export function useColorMode(): ColorModeContextValue {
  const context = useContext(ColorModeContext);
  if (context === undefined) {
    throw new Error("useColorMode must be used within a ColorModeProvider");
  }
  return context;
}

export const getClientColorMode = (): ColorMode => {
  const storedColorMode = getStoredColorMode();
  return isColorMode(storedColorMode) ? storedColorMode : "system";
};
