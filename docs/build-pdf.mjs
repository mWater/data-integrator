#!/usr/bin/env node
/**
 * Renders the architecture specifications in docs/spec/ to PDFs in docs/pdf/.
 *
 * Markdown is converted with markdown-it, mermaid fences are drawn by mermaid
 * inside headless Chrome, and Chrome prints the page with a title page, a
 * table of contents, running footers, and page numbers. Uses the system
 * Google Chrome via playwright-core, so no browser download is needed.
 *
 *   node docs/build-pdf.mjs            every specification
 *   node docs/build-pdf.mjs "System Architecture.md"
 */
import { execSync } from "node:child_process"
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import MarkdownIt from "markdown-it"
import { chromium } from "playwright-core"

const DOCS_DIR = path.dirname(fileURLToPath(import.meta.url))
const SPEC_DIR = path.join(DOCS_DIR, "spec")
const OUT_DIR = path.join(DOCS_DIR, "pdf")
const MERMAID_PATH = path.join(DOCS_DIR, "..", "node_modules", "mermaid", "dist", "mermaid.min.js")

/** Front-matter shown on every title page. */
const PROGRAMME = "Open Source Data Integrator Platform"
const PREPARED_BY = "Prepared by mWater for the UNICEF WASH Innovation Hub"
const IMPLEMENTATION = "Reference implementation: mWater Data Integrator"

/** Markdown renderer: HTML passthrough for the few inline tags, no smart quotes. */
const md = new MarkdownIt({ html: true, linkify: true, typographer: false })

// Mermaid fences become <pre class="mermaid"> for the in-page renderer; every
// other fence renders as a normal code block.
const defaultFence = md.renderer.rules.fence
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  if (token.info.trim() === "mermaid") {
    return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>\n`
  }
  return defaultFence(tokens, idx, options, env, self)
}

// Headings get stable ids so the table of contents can link to them.
md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const text = tokens[idx + 1].content
  const id = slug(text)
  token.attrSet("id", id)
  env.headings ??= []
  env.headings.push({ level: Number(token.tag.slice(1)), text, id })
  return self.renderToken(tokens, idx, options)
}

/** Turns a heading into an anchor id. */
function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

/** Git short hash of the working tree, for the title page. */
function revision() {
  try {
    const sha = execSync("git rev-parse --short HEAD", { cwd: DOCS_DIR, encoding: "utf8" }).trim()
    const dirty = execSync("git status --porcelain -- .", { cwd: DOCS_DIR, encoding: "utf8" }).trim() !== ""
    return dirty ? `${sha} (with local changes)` : sha
  } catch {
    return ""
  }
}

const CSS = `
  @page { size: A4; }
  :root {
    --ink: #1a1d21;
    --ink-muted: #55606b;
    --ink-faint: #8a939c;
    --rule: #d9dcdf;
    --accent: #256abf;
    --tint: #f3f6fa;
    --code-bg: #f4f4f2;
  }
  html { font-size: 10.5pt; }
  body {
    margin: 0;
    color: var(--ink);
    font-family: "IBM Plex Sans", "Source Sans 3", "Noto Sans", "DejaVu Sans", "Liberation Sans", sans-serif;
    line-height: 1.5;
    text-rendering: optimizeLegibility;
  }
  a { color: var(--accent); text-decoration: none; }

  /* Title page */
  .title-page {
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    break-after: page;
    min-height: 240mm;
  }
  .title-page .programme {
    font-size: 11pt;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-muted);
    padding-top: 40mm;
  }
  .title-page h1 {
    font-size: 30pt;
    font-weight: 600;
    line-height: 1.15;
    margin: 6mm 0 0 0;
    letter-spacing: -0.01em;
  }
  .title-page .rule {
    width: 28mm;
    height: 3px;
    background: var(--accent);
    margin: 10mm 0;
  }
  .title-page .meta {
    color: var(--ink-muted);
    font-size: 10pt;
    line-height: 1.7;
  }
  .title-page .meta strong { color: var(--ink); font-weight: 600; }

  /* Table of contents */
  .toc { break-after: page; }
  .toc h2 { margin-top: 0; }
  .toc ol { list-style: none; padding: 0; margin: 0; }
  .toc li { margin: 0; padding: 1.2mm 0; }
  .toc li.l3 { padding-left: 8mm; font-size: 9.5pt; color: var(--ink-muted); }
  .toc a { color: inherit; }

  /* Body */
  h2 {
    font-size: 17pt;
    font-weight: 600;
    margin: 12mm 0 4mm 0;
    padding-bottom: 2mm;
    border-bottom: 1px solid var(--rule);
    break-after: avoid;
    letter-spacing: -0.01em;
  }
  h2:first-of-type { margin-top: 0; }
  h3 {
    font-size: 12.5pt;
    font-weight: 600;
    margin: 8mm 0 3mm 0;
    break-after: avoid;
  }
  p { margin: 0 0 3.2mm 0; text-wrap: pretty; orphans: 3; widows: 3; }
  ul, ol { margin: 0 0 3.2mm 0; padding-left: 6mm; }
  li { margin-bottom: 1.2mm; }
  li > p { margin-bottom: 1.2mm; }
  strong { font-weight: 600; }
  em { font-style: italic; }

  code, pre {
    font-family: "IBM Plex Mono", "JetBrains Mono", "DejaVu Sans Mono", "Liberation Mono", monospace;
    font-size: 0.88em;
  }
  code { background: var(--code-bg); padding: 0.1em 0.3em; border-radius: 2px; }
  pre {
    background: var(--code-bg);
    padding: 3mm 4mm;
    border-radius: 3px;
    overflow: hidden;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.45;
    margin: 0 0 4mm 0;
    break-inside: avoid;
  }
  pre code { background: none; padding: 0; font-size: inherit; }

  table {
    width: 100%;
    border-collapse: collapse;
    margin: 0 0 5mm 0;
    font-size: 9.2pt;
    line-height: 1.4;
  }
  thead { display: table-header-group; }
  th, td {
    text-align: left;
    vertical-align: top;
    padding: 1.8mm 2.4mm;
    border-bottom: 1px solid var(--rule);
  }
  th {
    font-weight: 600;
    background: var(--tint);
    border-bottom: 1.5px solid #b9c3cd;
  }
  tr { break-inside: avoid; }
  td code { font-size: 0.92em; }

  /* Mermaid diagrams */
  pre.mermaid {
    background: none;
    padding: 0;
    margin: 4mm 0 6mm 0;
    text-align: center;
    break-inside: avoid;
  }
  pre.mermaid svg { max-width: 100%; height: auto; max-height: 170mm; }

  blockquote {
    margin: 0 0 4mm 0;
    padding: 1mm 0 1mm 4mm;
    border-left: 2px solid var(--accent);
    color: var(--ink-muted);
  }
  hr { border: 0; border-top: 1px solid var(--rule); margin: 6mm 0; }
`

/** Footer shown on every page after the title page (Chrome header/footer template). */
function footerTemplate(title) {
  return `
    <div style="width: 100%; padding: 0 18mm; box-sizing: border-box; display: flex; justify-content: space-between;
                font-family: 'IBM Plex Sans', 'Noto Sans', 'DejaVu Sans', sans-serif; font-size: 8pt; color: #8a939c;">
      <span>${escapeHtml(title)}</span>
      <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
    </div>`
}

/** Minimal HTML escaping for text we place in templates. */
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
}

/** Builds the full HTML document for one Markdown source. */
function buildHtml(markdown, rev) {
  const env = {}
  const body = md.render(markdown, env)
  const headings = env.headings ?? []
  const h1 = headings.find(h => h.level === 1)
  const title = h1?.text ?? "Untitled"
  // The H1 moves to the title page
  const bodyWithoutH1 = h1 ? body.replace(/<h1[^>]*>[\s\S]*?<\/h1>\n?/, "") : body

  const toc = headings
    .filter(h => h.level === 2 || h.level === 3)
    .map(h => `<li class="l${h.level}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
    .join("\n")

  const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<section class="title-page">
  <div>
    <div class="programme">${PROGRAMME}</div>
    <h1>${escapeHtml(title)}</h1>
    <div class="rule"></div>
    <div class="meta">
      <div>${PREPARED_BY}</div>
      <div>${IMPLEMENTATION}</div>
    </div>
  </div>
  <div class="meta">
    <div><strong>${date}</strong></div>
    ${rev ? `<div>Revision ${escapeHtml(rev)}</div>` : ""}
    <div>Licensed under the Apache License, Version 2.0</div>
  </div>
</section>
<nav class="toc">
  <h2>Contents</h2>
  <ol>
${toc}
  </ol>
</nav>
<main>
${bodyWithoutH1}
</main>
</body>
</html>`
}

async function main() {
  const only = process.argv.slice(2)
  const files = (await readdir(SPEC_DIR)).filter(f => f.endsWith(".md")).filter(f => only.length === 0 || only.includes(f)).sort()
  if (files.length === 0) {
    console.error("No Markdown documents matched.")
    process.exit(1)
  }
  await mkdir(OUT_DIR, { recursive: true })
  const rev = revision()

  const browser = await chromium.launch({ channel: "chrome", headless: true })
  try {
    for (const file of files) {
      const markdown = await readFile(path.join(SPEC_DIR, file), "utf8")
      const html = buildHtml(markdown, rev)
      const htmlPath = path.join(OUT_DIR, file.replace(/\.md$/, ".html"))
      await writeFile(htmlPath, html)

      const page = await browser.newPage()
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" })
      await page.addScriptTag({ path: MERMAID_PATH })
      await page.evaluate(async () => {
        mermaid.initialize({
          startOnLoad: false,
          theme: "neutral",
          securityLevel: "loose",
          fontFamily: '"IBM Plex Sans", "Noto Sans", "DejaVu Sans", sans-serif',
          themeVariables: { fontSize: "13px" },
          flowchart: { htmlLabels: true, useMaxWidth: false, padding: 10 },
          sequence: { useMaxWidth: false, messageFontSize: 12, actorFontSize: 13, noteFontSize: 12, width: 130 }
        })
        await mermaid.run({ querySelector: "pre.mermaid" })
        await document.fonts.ready
      })
      await page.emulateMedia({ media: "print" })

      const title = await page.title()
      const pdfPath = path.join(OUT_DIR, file.replace(/\.md$/, ".pdf"))
      await page.pdf({
        path: pdfPath,
        format: "A4",
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: "20mm", bottom: "20mm", left: "18mm", right: "18mm" },
        displayHeaderFooter: true,
        headerTemplate: "<span></span>",
        footerTemplate: footerTemplate(title)
      })
      await page.close()
      await unlink(htmlPath)
      console.log(`${file} -> ${path.relative(process.cwd(), pdfPath)}`)
    }
  } finally {
    await browser.close()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
