export const WindowChromeChannel = {
  SetTheme: "window-chrome:set-theme",
  ShowApplicationMenu: "window-chrome:show-application-menu",
} as const;

export const windowChromeColors = {
  light: { color: "#f5f8fd", symbolColor: "#17243a" },
  dark: { color: "#141b27", symbolColor: "#e6edf8" },
} as const;

export type WindowChromeTheme = keyof typeof windowChromeColors;
