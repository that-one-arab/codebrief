/**
 * Syntax highlighting using vscode-textmate with theme-aware tokenization.
 * Uses tokenizeLine2() with the active VS Code theme to produce inline styles
 * that exactly match the editor's syntax colors.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fsPromises from 'fs/promises';
import { Registry, INITIAL, IRawGrammar } from 'vscode-textmate';
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma';
import { logger } from './logger';
import { loadActiveTheme, invalidateThemeCache } from './themeLoader';
import { DiffLine } from '../types';

const DEBUG_HIGHLIGHTER = false;

function debugLog(message: string): void {
  if (DEBUG_HIGHLIGHTER) {
    logger.debug('highlighter', message);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export interface TokenizedLineHtml {
  type: 'add' | 'del' | 'context';
  html: string;
}

interface OnigScannerLib {
  createOnigScanner(patterns: string[]): OnigScanner;
  createOnigString(s: string): OnigString;
}

interface IRawGrammarExtended extends IRawGrammar {
  embeddedLanguages?: Record<string, string>;
}

// Bit masks for decoding tokenizeLine2() binary metadata
const FONT_STYLE_MASK = 0x7800;
const FONT_STYLE_OFFSET = 11;
const FOREGROUND_MASK = 0x1FF8000;
const FOREGROUND_OFFSET = 15;

// Font style bit flags
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;
const FONT_STYLE_STRIKETHROUGH = 8;

// Cache for loaded grammars
const grammarCache = new Map<string, IRawGrammar>();
let onigurumaInitialized = false;
let scannerLib: OnigScannerLib | null = null;
let globalRegistry: Registry | null = null;
let currentColorMap: string[] = [];
let currentEditorForeground: string = '#cccccc';

async function getOnigurumaWASMPath(): Promise<string> {
  const paths = [
    path.join(__dirname, 'onig.wasm'),
    path.join(__dirname, '..', 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm'),
    path.join(__dirname, '..', '..', 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm'),
  ];

  for (const p of paths) {
    if (await fileExists(p)) {
      return p;
    }
  }

  throw new Error('Could not find onig.wasm in any expected location');
}

async function initOniguruma(): Promise<void> {
  if (onigurumaInitialized) return;

  try {
    const wasmPath = await getOnigurumaWASMPath();
    debugLog(`Loading oniguruma WASM from: ${wasmPath}`);

    const wasmBin = await fsPromises.readFile(wasmPath);
    const arrayBuffer = wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength);

    await loadWASM(arrayBuffer);

    scannerLib = {
      createOnigScanner(patterns: string[]) {
        return new OnigScanner(patterns);
      },
      createOnigString(s: string) {
        return new OnigString(s);
      }
    };

    onigurumaInitialized = true;
    debugLog('Oniguruma initialized successfully');
  } catch (error) {
    logger.error('highlighter', 'Failed to initialize oniguruma', { error: String(error) });
    throw error;
  }
}

function getLanguageIdFromPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();

  if (basename === 'dockerfile' || basename.startsWith('dockerfile.')) {
    return 'dockerfile';
  }
  if (basename === 'makefile' || basename === 'gnumakefile') {
    return 'makefile';
  }
  if (basename === 'rakefile') {
    return 'ruby';
  }

  const extensionMap: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.js': 'javascript',
    '.jsx': 'javascriptreact',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.json': 'json',
    '.jsonc': 'jsonc',
    '.py': 'python',
    '.pyw': 'python',
    '.pyi': 'python',
    '.java': 'java',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.c': 'c',
    '.h': 'cpp',
    '.hpp': 'cpp',
    '.cs': 'csharp',
    '.go': 'go',
    '.rs': 'rust',
    '.rb': 'ruby',
    '.php': 'php',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.scala': 'scala',
    '.sc': 'scala',
    '.sh': 'shellscript',
    '.bash': 'shellscript',
    '.zsh': 'shellscript',
    '.fish': 'fish',
    '.ps1': 'powershell',
    '.psm1': 'powershell',
    '.html': 'html',
    '.htm': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.sass': 'sass',
    '.less': 'less',
    '.xml': 'xml',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'toml',
    '.ini': 'ini',
    '.cfg': 'ini',
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.sql': 'sql',
    '.vue': 'vue',
    '.svelte': 'svelte',
    '.dart': 'dart',
    '.r': 'r',
    '.m': 'objective-c',
    '.mm': 'objective-cpp',
    '.lua': 'lua',
    '.pl': 'perl',
    '.pm': 'perl',
    '.ex': 'elixir',
    '.exs': 'elixir',
    '.erl': 'erlang',
    '.hrl': 'erlang',
    '.fs': 'fsharp',
    '.fsx': 'fsharp',
    '.fsi': 'fsharp',
    '.clj': 'clojure',
    '.cljs': 'clojure',
    '.hs': 'haskell',
    '.lhs': 'haskell',
    '.ml': 'ocaml',
    '.mli': 'ocaml',
    '.coffee': 'coffeescript',
    '.litcoffee': 'coffeescript',
    '.graphql': 'graphql',
    '.gql': 'graphql',
  };

  return extensionMap[ext] || null;
}

async function findGrammarForLanguage(languageId: string): Promise<{ path: string; scopeName: string } | null> {
  const cacheKey = `lang:${languageId}`;
  if (grammarCache.has(cacheKey)) {
    const cached = grammarCache.get(cacheKey)!;
    return { path: '', scopeName: cached.scopeName };
  }

  const extensions = vscode.extensions.all;

  for (const ext of extensions) {
    const packageJson = ext.packageJSON;
    if (!packageJson.contributes?.grammars) continue;

    for (const grammar of packageJson.contributes.grammars) {
      if (grammar.language === languageId) {
        const grammarPath = path.join(ext.extensionPath, grammar.path);
        if (await fileExists(grammarPath)) {
          try {
            const content = await fsPromises.readFile(grammarPath, 'utf8');
            const parsed = parseGrammarContent(content);
            if (parsed && parsed.scopeName) {
              grammarCache.set(cacheKey, parsed);
              grammarCache.set(parsed.scopeName, parsed);
              return { path: grammarPath, scopeName: parsed.scopeName };
            }
          } catch (e) {
            debugLog(`Failed to parse grammar at ${grammarPath}: ${e}`);
          }
        }
      }
    }
  }

  return null;
}

function parseGrammarContent(content: string): IRawGrammar | null {
  try {
    return JSON.parse(content) as IRawGrammar;
  } catch {
    try {
      const stripped = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      return JSON.parse(stripped) as IRawGrammar;
    } catch (e) {
      debugLog(`Failed to parse grammar: ${e}`);
      return null;
    }
  }
}

async function loadGrammarByScope(scopeName: string): Promise<IRawGrammar | null> {
  if (grammarCache.has(scopeName)) {
    return grammarCache.get(scopeName)!;
  }

  const extensions = vscode.extensions.all;

  for (const ext of extensions) {
    const packageJson = ext.packageJSON;
    if (!packageJson.contributes?.grammars) continue;

    for (const grammar of packageJson.contributes.grammars) {
      const grammarPath = path.join(ext.extensionPath, grammar.path);

      if (!(await fileExists(grammarPath))) continue;

      try {
        const content = await fsPromises.readFile(grammarPath, 'utf8');
        const parsed = parseGrammarContent(content);

        if (parsed) {
          grammarCache.set(parsed.scopeName, parsed);

          if (parsed.scopeName === scopeName) {
            return parsed;
          }

          const parsedExtended = parsed as IRawGrammarExtended;
          if (parsedExtended.embeddedLanguages) {
            for (const [embedScope] of Object.entries(parsedExtended.embeddedLanguages)) {
              if (embedScope === scopeName) {
                return parsed;
              }
            }
          }
        }
      } catch (e) {
        // Ignore errors and continue searching
      }
    }
  }

  return null;
}

/**
 * Ensure the global Registry exists with the active theme loaded.
 */
async function ensureRegistry(): Promise<void> {
  if (!scannerLib) {
    throw new Error('Oniguruma not initialized');
  }

  const { rawTheme, editorForeground } = await loadActiveTheme();
  currentEditorForeground = editorForeground;

  if (!globalRegistry) {
    globalRegistry = new Registry({
      onigLib: Promise.resolve(scannerLib),
      theme: rawTheme,
      loadGrammar: async (scopeName: string) => {
        if (grammarCache.has(scopeName)) {
          return grammarCache.get(scopeName)!;
        }
        return loadGrammarByScope(scopeName);
      }
    });
  }

  currentColorMap = globalRegistry.getColorMap();
}

/**
 * Build an inline style string from token metadata.
 */
function metadataToStyle(metadata: number): string {
  const fgIndex = (metadata & FOREGROUND_MASK) >>> FOREGROUND_OFFSET;
  const fontStyle = (metadata & FONT_STYLE_MASK) >>> FONT_STYLE_OFFSET;

  const parts: string[] = [];

  // Look up foreground color from the color map
  const fg = currentColorMap[fgIndex];
  if (fg && fg !== currentEditorForeground) {
    parts.push(`color:${fg}`);
  }

  if (fontStyle & FONT_STYLE_ITALIC) {
    parts.push('font-style:italic');
  }
  if (fontStyle & FONT_STYLE_BOLD) {
    parts.push('font-weight:bold');
  }
  if (fontStyle & FONT_STYLE_UNDERLINE) {
    parts.push('text-decoration:underline');
  }
  if (fontStyle & FONT_STYLE_STRIKETHROUGH) {
    parts.push('text-decoration:line-through');
  }

  return parts.join(';');
}

/**
 * Tokenize diff lines using the active theme and return inline-styled HTML.
 */
export async function tokenizeDiff(
  filePath: string,
  lines: DiffLine[]
): Promise<TokenizedLineHtml[]> {
  try {
    debugLog(`Tokenizing ${lines.length} lines for ${filePath}`);
    await initOniguruma();

    const languageId = getLanguageIdFromPath(filePath);
    debugLog(`Detected language: ${languageId}`);

    if (!languageId || !scannerLib) {
      debugLog('No language detected or oniguruma not initialized');
      return lines.map(line => ({
        type: line.type,
        html: escapeHtml(line.content) || ' '
      }));
    }

    const grammarInfo = await findGrammarForLanguage(languageId);
    debugLog(`Grammar info: ${JSON.stringify(grammarInfo)}`);

    if (!grammarInfo) {
      debugLog(`No grammar found for ${languageId}`);
      return lines.map(line => ({
        type: line.type,
        html: escapeHtml(line.content) || ' '
      }));
    }

    await ensureRegistry();

    const grammar = await globalRegistry!.loadGrammar(grammarInfo.scopeName);

    if (!grammar) {
      return lines.map(line => ({
        type: line.type,
        html: escapeHtml(line.content) || ' '
      }));
    }

    const result: TokenizedLineHtml[] = [];
    let ruleStack = INITIAL;

    for (const line of lines) {
      const lineResult = grammar.tokenizeLine2(line.content, ruleStack);
      const tokens = lineResult.tokens; // Uint32Array: [startIndex, metadata, startIndex, metadata, ...]

      let html = '';
      const tokenCount = tokens.length / 2;

      for (let i = 0; i < tokenCount; i++) {
        const startIndex = tokens[2 * i];
        const metadata = tokens[2 * i + 1];
        const endIndex = i + 1 < tokenCount ? tokens[2 * (i + 1)] : line.content.length;
        const content = line.content.substring(startIndex, endIndex);

        if (content.length === 0) continue;

        const escapedContent = escapeHtml(content);
        const style = metadataToStyle(metadata);

        if (style) {
          html += `<span style="${style}">${escapedContent}</span>`;
        } else {
          html += escapedContent;
        }
      }

      result.push({
        type: line.type,
        html: html || ' '
      });

      ruleStack = lineResult.ruleStack;
    }

    debugLog(`Tokenization complete for ${lines.length} lines`);
    return result;
  } catch (error) {
    console.error('Tokenization error for', filePath, ':', error);
    return lines.map(line => ({
      type: line.type,
      html: escapeHtml(line.content) || ' '
    }));
  }
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Check if a file can be highlighted.
 */
export function canHighlight(filePath: string): boolean {
  return getLanguageIdFromPath(filePath) !== null;
}

/**
 * Reload the theme into the registry. Called when the user switches themes.
 */
export async function reloadTheme(): Promise<void> {
  invalidateThemeCache();
  const { rawTheme, editorForeground } = await loadActiveTheme();
  currentEditorForeground = editorForeground;

  if (globalRegistry) {
    globalRegistry.setTheme(rawTheme);
    currentColorMap = globalRegistry.getColorMap();
  }

  logger.debug('highlighter', 'Theme reloaded');
}
