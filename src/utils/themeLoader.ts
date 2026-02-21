/**
 * Theme loader: reads the active VS Code color theme from disk
 * and converts it to an IRawTheme for vscode-textmate's Registry.setTheme().
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fsPromises from 'fs/promises';
import { IRawTheme } from 'vscode-textmate';
import { logger } from './logger';

interface ThemeSetting {
  name?: string;
  scope?: string | string[];
  settings: {
    foreground?: string;
    background?: string;
    fontStyle?: string;
  };
}

interface ThemeJson {
  name?: string;
  include?: string;
  tokenColors?: ThemeSetting[];
  colors?: Record<string, string>;
}

interface LoadedTheme {
  rawTheme: IRawTheme;
  editorForeground: string;
}

let cachedTheme: LoadedTheme | null = null;
let cachedThemeId: string | null = null;

/**
 * Get the active color theme ID from VS Code settings.
 */
function getActiveThemeId(): string {
  const config = vscode.workspace.getConfiguration('workbench');
  return config.get<string>('colorTheme', 'Default Dark Modern');
}

/**
 * Find the path to the theme JSON file by searching all extensions.
 */
function findThemePath(themeId: string): string | null {
  for (const ext of vscode.extensions.all) {
    const pkg = ext.packageJSON;
    const themes: any[] = pkg?.contributes?.themes;
    if (!themes) continue;

    for (const t of themes) {
      if (t.id === themeId || t.label === themeId) {
        return path.join(ext.extensionPath, t.path);
      }
    }
  }
  return null;
}

/**
 * Read and parse a theme JSON file, handling JSON with comments.
 */
async function readThemeJson(themePath: string): Promise<ThemeJson | null> {
  try {
    const raw = await fsPromises.readFile(themePath, 'utf-8');
    // Strip single-line and multi-line comments (JSON with comments)
    const stripped = raw
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    // Strip trailing commas before } or ]
    const cleaned = stripped.replace(/,\s*([\]}])/g, '$1');
    return JSON.parse(cleaned) as ThemeJson;
  } catch (e) {
    logger.warn('themeLoader', 'Failed to read theme', { themePath, error: String(e) });
    return null;
  }
}

/**
 * Recursively resolve a theme's `include` chain, merging tokenColors.
 * Base theme tokenColors come first so child overrides take precedence.
 */
async function resolveThemeChain(
  themePath: string,
  visited: Set<string> = new Set()
): Promise<{ tokenColors: ThemeSetting[]; colors: Record<string, string> }> {
  const resolved = path.resolve(themePath);
  if (visited.has(resolved)) {
    return { tokenColors: [], colors: {} };
  }
  visited.add(resolved);

  const themeJson = await readThemeJson(resolved);
  if (!themeJson) {
    return { tokenColors: [], colors: {} };
  }

  let baseTokenColors: ThemeSetting[] = [];
  let baseColors: Record<string, string> = {};

  if (themeJson.include) {
    const includePath = path.resolve(path.dirname(resolved), themeJson.include);
    const base = await resolveThemeChain(includePath, visited);
    baseTokenColors = base.tokenColors;
    baseColors = base.colors;
  }

  const mergedColors = { ...baseColors, ...(themeJson.colors || {}) };
  const mergedTokenColors = [...baseTokenColors, ...(themeJson.tokenColors || [])];

  return { tokenColors: mergedTokenColors, colors: mergedColors };
}

/**
 * Convert resolved tokenColors + colors into an IRawTheme for vscode-textmate.
 * Prepends a default entry with editor.foreground as the base color.
 */
function toRawTheme(
  tokenColors: ThemeSetting[],
  colors: Record<string, string>,
): { rawTheme: IRawTheme; editorForeground: string } {
  const editorFg = colors['editor.foreground'] || '#cccccc';
  const editorBg = colors['editor.background'] || '#1e1e1e';

  // Prepend default foreground/background as first entry (no scope = global default)
  const settings: ThemeSetting[] = [
    {
      settings: {
        foreground: editorFg,
        background: editorBg,
      },
    },
    ...tokenColors,
  ];

  return {
    rawTheme: { name: 'active-theme', settings },
    editorForeground: editorFg,
  };
}

/**
 * Load the active VS Code theme as an IRawTheme.
 * Results are cached by theme ID and reused until invalidated.
 */
export async function loadActiveTheme(): Promise<LoadedTheme> {
  const themeId = getActiveThemeId();

  if (cachedTheme && cachedThemeId === themeId) {
    return cachedTheme;
  }

  const themePath = findThemePath(themeId);
  if (!themePath) {
    logger.warn('themeLoader', 'Theme path not found, using fallback', { themeId });
    const fallback = toRawTheme([], {});
    cachedTheme = fallback;
    cachedThemeId = themeId;
    return fallback;
  }

  const { tokenColors, colors } = await resolveThemeChain(themePath);
  const result = toRawTheme(tokenColors, colors);

  cachedTheme = result;
  cachedThemeId = themeId;

  logger.debug('themeLoader', 'Theme loaded', { themeId, tokenRules: tokenColors.length });
  return result;
}

/**
 * Clear the theme cache. Called when the user switches themes.
 */
export function invalidateThemeCache(): void {
  cachedTheme = null;
  cachedThemeId = null;
}
