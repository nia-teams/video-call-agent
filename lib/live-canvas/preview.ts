const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
  'circle', 'ellipse', 'line', 'path', 'polygon', 'polyline', 'rect', 'stop', 'use',
])

function extractBalancedPartialCss(rawCss: string): string {
  let depth = 0
  let inSingle = false
  let inDouble = false
  let inComment = false
  let lastBalancedEnd = -1
  for (let i = 0; i < rawCss.length; i++) {
    const ch = rawCss[i]
    const next = i + 1 < rawCss.length ? rawCss[i + 1] : ''
    if (inComment) {
      if (ch === '*' && next === '/') {
        inComment = false
        i++
      }
      continue
    }
    if (!inSingle && !inDouble && ch === '/' && next === '*') {
      inComment = true
      i++
      continue
    }
    if (ch === '\\') {
      if (i + 1 < rawCss.length) i++
      continue
    }
    if (inSingle) {
      if (ch === "'" || ch === '\n') inSingle = false
      continue
    }
    if (inDouble) {
      if (ch === '"' || ch === '\n') inDouble = false
      continue
    }
    if (ch === "'") {
      inSingle = true
    } else if (ch === '"') {
      inDouble = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}' && depth > 0) {
      depth--
      if (depth === 0) lastBalancedEnd = i
    }
  }
  if (lastBalancedEnd < 0) return ''
  return rawCss
    .slice(0, lastBalancedEnd + 1)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim()
}

function closeOpenMarkupTags(html: string): string {
  const stack: string[] = []
  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)\b(?:"[^"]*"|'[^']*'|[^>"'])*>/g
  let match: RegExpExecArray | null
  while ((match = tagRegex.exec(html)) !== null) {
    const fullTag = match[0]
    const rawName = match[1] ?? ''
    const lower = rawName.toLowerCase()
    if (VOID_TAGS.has(lower)) continue
    if (fullTag.startsWith('</')) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.toLowerCase() === lower) {
          stack.length = i
          break
        }
      }
    } else if (!fullTag.endsWith('/>')) {
      stack.push(rawName)
    }
  }
  let suffix = ''
  for (let i = stack.length - 1; i >= 0; i--) {
    suffix += `</${stack[i]}>`
  }
  return html + suffix
}

function stripTrailingIncompleteTag(html: string): string {
  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)\b(?:"[^"]*"|'[^']*'|[^>"'])*>/g
  let lastCompleteTagEnd = 0
  let match: RegExpExecArray | null
  while ((match = tagRegex.exec(html)) !== null) {
    lastCompleteTagEnd = match.index + match[0].length
  }
  const tail = html.slice(lastCompleteTagEnd)
  const incompleteMatch = tail.match(/<(?:\/?[a-zA-Z!]|\/?$)/)
  if (!incompleteMatch || incompleteMatch.index === undefined) return html
  return html.slice(0, lastCompleteTagEnd + incompleteMatch.index)
}

/**
 * Sanitizes and auto-closes partial streaming HTML/SVG so the client can
 * render progressive elements smoothly before the closing tags arrive.
 */
export function prepareStreamingPreview(
  raw: string,
): { styles: string; html: string } {
  const cleaned = raw
    .replace(/^```(?:html|svg|xml)?\s*/i, '')
    .replace(/```\s*$/i, '')

  const styleMatches = cleaned.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)
  const completedStyles = styleMatches
    ? styleMatches.map(s => s.replace(/<\/?style\b[^>]*>/gi, '')).join('\n')
    : ''
  const withoutCompletedStyles = cleaned.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  const openStyleMatch = withoutCompletedStyles.match(/<style\b[^>]*>([\s\S]*)$/i)
  const partialStyles = openStyleMatch ? extractBalancedPartialCss(openStyleMatch[1] ?? '') : ''
  const styles = [completedStyles, partialStyles].filter(Boolean).join('\n')


  // Strip HTML comments and style/script/head blocks during intermediate streaming preview
  const body = stripTrailingIncompleteTag(
    cleaned
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<!--[\s\S]*$/g, '')
      .replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<(style|script|head)\b[^>]*>[\s\S]*$/gi, ''),
  ).replace(/&[a-zA-Z0-9#]*$/, '')

  return { styles, html: closeOpenMarkupTags(body) }
}

/** Reads only actual top-level string fields, including a safely decoded partial value.
 * Incomplete escapes are withheld; callers must require `closed` before speaking. */
export function extractStreamingStringArg(partialJson: string, keyName: string): { value: string; closed: boolean } {
  const absent = { value: '', closed: false }
  let i = 0
  const whitespace = () => { while (/\s/.test(partialJson[i] ?? '') && i < partialJson.length) i++ }
  const string = (): { value: string; closed: boolean } => {
    i++ // opening quote
    let value = ''
    while (i < partialJson.length) {
      const ch = partialJson[i++]!
      if (ch === '"') return { value, closed: true }
      if (ch.charCodeAt(0) < 32) return { value, closed: false }
      if (ch !== '\\') { value += ch; continue }
      const escape = partialJson[i++]
      const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
      if (escape === 'u') {
        const hex = partialJson.slice(i, i + 4)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { value, closed: false }
        value += String.fromCharCode(parseInt(hex, 16))
        i += 4
      } else if (escape !== undefined && escape in escapes) {
        value += escapes[escape]
      } else return { value, closed: false }
    }
    return { value, closed: false }
  }
  whitespace()
  if (partialJson[i++] !== '{') return absent
  while (i < partialJson.length) {
    whitespace()
    if (partialJson[i] !== '"') return absent
    const key = string()
    if (!key.closed) return absent
    whitespace()
    if (partialJson[i++] !== ':') return absent
    whitespace()
    if (partialJson[i] === '"') {
      const field = string()
      if (key.value === keyName) return field
      if (!field.closed) return absent
    } else {
      // Skip a non-string value without treating nested keys as top-level keys.
      const stack: string[] = []
      const start = i
      while (i < partialJson.length) {
        const ch = partialJson[i]!
        if (ch === '"') { if (!string().closed) return absent; continue }
        if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']')
        else if (stack.length && (ch === '}' || ch === ']')) {
          if (stack.pop() !== ch) return absent
        } else if (!stack.length && (ch === ',' || ch === '}')) break
        i++
      }
      if (stack.length) return absent
      try { JSON.parse(partialJson.slice(start, i)) } catch { return absent }
      if (key.value === keyName) return absent
    }
    whitespace()
    if (partialJson[i++] !== ',') return absent
  }
  return absent
}

export function extractStreamingHtmlArg(partialJson: string): string {
  return extractStreamingStringArg(partialJson, 'html').value
}

