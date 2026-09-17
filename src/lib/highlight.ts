/**
 * Syntax highlighting for the diff views, backed by Shiki (TextMate grammars,
 * 340+ languages). Everything is loaded lazily: the engine on first use, each
 * grammar when a file of that language is first shown.
 */
import type { BundledLanguage, BundledTheme, HighlighterGeneric, ThemedToken } from "shiki";

export type LineTokens = ThemedToken[];

const DARK: BundledTheme = "github-dark";
const LIGHT: BundledTheme = "github-light";

/** File extension → Shiki language id. */
const EXT: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "jsonc", json5: "json5", jsonl: "json",
  md: "markdown", markdown: "markdown", mdx: "mdx", rst: "rst", tex: "latex", bib: "bibtex", adoc: "asciidoc",
  rs: "rust", go: "go", py: "python", pyi: "python", pyw: "python", ipynb: "json",
  java: "java", kt: "kotlin", kts: "kotlin", scala: "scala", sc: "scala", groovy: "groovy", gradle: "groovy", clj: "clojure", cljs: "clojure", cljc: "clojure",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp", ino: "cpp", cu: "cuda-cpp", cuh: "cuda-cpp",
  cs: "csharp", fs: "fsharp", fsx: "fsharp", vb: "vb", swift: "swift", m: "objective-c", mm: "objective-cpp", dart: "dart",
  rb: "ruby", erb: "erb", php: "php", pl: "perl", pm: "perl", lua: "lua", r: "r", rmd: "markdown", jl: "julia", ex: "elixir", exs: "elixir", erl: "erlang", hrl: "erlang",
  hs: "haskell", lhs: "haskell", ml: "ocaml", mli: "ocaml", elm: "elm", purs: "purescript", nim: "nim", zig: "zig", v: "v", d: "d", cr: "crystal", rkt: "racket", scm: "scheme", lisp: "lisp", el: "lisp", coffee: "coffee", moon: "moonscript",
  html: "html", htm: "html", xhtml: "html", vue: "vue", svelte: "svelte", astro: "astro", pug: "pug", jade: "pug", hbs: "handlebars", handlebars: "handlebars", mustache: "handlebars", twig: "twig", liquid: "liquid", ejs: "html", njk: "jinja", jinja: "jinja", jinja2: "jinja", j2: "jinja",
  css: "css", scss: "scss", sass: "sass", less: "less", styl: "stylus", postcss: "postcss",
  xml: "xml", xsl: "xml", xslt: "xml", svg: "xml", plist: "xml", xaml: "xml", csproj: "xml", vcxproj: "xml", props: "xml", targets: "xml", resx: "xml", storyboard: "xml", wsdl: "xml", xsd: "xml",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", cfg: "ini", conf: "ini", properties: "properties", env: "dotenv", editorconfig: "ini",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", ksh: "shellscript", fish: "fish", ps1: "powershell", psm1: "powershell", psd1: "powershell", bat: "bat", cmd: "bat", nu: "nushell",
  sql: "sql", psql: "sql", mysql: "sql", pgsql: "sql", plsql: "plsql", graphql: "graphql", gql: "graphql", proto: "proto", prisma: "prisma", thrift: "thrift",
  dockerfile: "docker", cmake: "cmake", make: "make", mk: "make", nix: "nix", hcl: "hcl", tf: "terraform", tfvars: "terraform", bzl: "starlark", bazel: "starlark", star: "starlark",
  diff: "diff", patch: "diff", csv: "csv", tsv: "csv", log: "log",
  asm: "asm", s: "asm", nasm: "asm", wat: "wasm", wast: "wasm", ll: "llvm", glsl: "glsl", vert: "glsl", frag: "glsl", hlsl: "hlsl", wgsl: "wgsl", metal: "cpp", cl: "c",
  sol: "solidity", move: "move", cairo: "cairo", vy: "vyper", mojo: "mojo", gd: "gdscript", gdshader: "gdshader", tscn: "gdresource", tres: "gdresource",
  vim: "viml", vimrc: "viml", ahk: "ahk", au3: "autoit", awk: "awk", tcl: "tcl", vhd: "vhdl", vhdl: "vhdl", sv: "system-verilog", svh: "system-verilog", verilog: "verilog",
  apex: "apex", cls: "apex", abap: "abap", cob: "cobol", cbl: "cobol", f90: "fortran-free-form", f: "fortran-fixed-form", for: "fortran-fixed-form", pas: "pascal", pp: "pascal", ada: "ada", adb: "ada", ads: "ada",
  http: "http", rest: "http", mmd: "mermaid", mermaid: "mermaid", dot: "dot", gv: "dot", puml: "plantuml", plantuml: "plantuml",
  txt: "", text: "",
};

/** Well-known file names without a telling extension. */
const NAMES: Record<string, string> = {
  dockerfile: "docker", containerfile: "docker", makefile: "make", gnumakefile: "make", "cmakelists.txt": "cmake",
  "cargo.lock": "toml", "gemfile": "ruby", "gemfile.lock": "ruby", rakefile: "ruby", vagrantfile: "ruby", podfile: "ruby", brewfile: "ruby",
  jenkinsfile: "groovy", "build.gradle": "groovy", ".env": "dotenv", "tsconfig.json": "jsonc", "jsconfig.json": "jsonc", ".babelrc": "jsonc", ".eslintrc": "jsonc",
  ".bashrc": "shellscript", ".zshrc": "shellscript", ".profile": "shellscript", ".bash_profile": "shellscript", "go.mod": "go", "go.sum": "go",
  ".gitattributes": "properties", ".gitmodules": "ini", ".npmrc": "ini", ".editorconfig": "ini", "license": "", "readme": "markdown",
};

/** Shiki language id for a repository path, or null for plain text. */
export function languageFor(path: string): string | null {
  const base = (path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path).toLowerCase();
  if (base in NAMES) return NAMES[base] || null;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = base.slice(dot + 1);
  // Names like ".gitignore" have no extension of their own.
  if (dot === 0) return null;
  return EXT[ext] || null;
}

let highlighterPromise: Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> | null = null;
const loadedLangs = new Set<string>();
let knownLangs: Set<string> | null = null;

async function highlighter() {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const shiki = await import("shiki");
      const { createOnigurumaEngine } = await import("shiki/engine/oniguruma");
      knownLangs = new Set(Object.keys(shiki.bundledLanguages));
      return shiki.createHighlighter({ themes: [DARK, LIGHT], langs: [], engine: createOnigurumaEngine(import("shiki/wasm")) });
    })();
  }
  return highlighterPromise;
}

/**
 * Tokens for every line of `text` (one array per line, empty for blank lines).
 * Returns an empty list when the language is unknown, so callers fall back to
 * plain text.
 */
export async function tokenizeLines(text: string, lang: string, theme: "dark" | "light"): Promise<LineTokens[]> {
  const hl = await highlighter();
  if (!knownLangs?.has(lang)) return [];
  if (!loadedLangs.has(lang)) {
    await hl.loadLanguage(lang as BundledLanguage);
    loadedLangs.add(lang);
  }
  return hl.codeToTokensBase(text, { lang: lang as BundledLanguage, theme: theme === "dark" ? DARK : LIGHT, includeExplanation: false });
}
