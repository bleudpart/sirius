#!/usr/bin/env node
// Extrait les textes visibles (JSX, attributs, libellés des registres) vers
// src/i18n/locales/fr.json, puis signale les clés absentes de en.json et ta.json.
// Usage : node scripts/i18n-extract.cjs [--check]
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const ROOT = path.join(__dirname, '..', 'src');
const LOCALES = path.join(ROOT, 'i18n', 'locales');
const ATTRS = new Set(['placeholder', 'title', 'aria-label', 'alt', 'label']);
const DATA_KEYS = new Set([
  'label', 'title', 'description', 'desc', 'placeholder', 'hint', 'subtitle', 'text', 'help',
  'empty', 'cta', 'tooltip', 'caption', 'summary', 'heading', 'message', 'short', 'long', 'tagline',
]);

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isHumanText(text) {
  if (!text || text.length > 400) return false;
  if (!/[A-Za-zÀ-ÿ]/.test(text)) return false;
  if (/^https?:|^\/|^[\w.-]+@[\w.-]+$/.test(text)) return false;
  if (/^[a-z0-9_.:\/#-]+$/.test(text)) return false;
  if (/rgba?\(|var\(--|^\d+(px|rem|em|%)\b|drop-shadow\(|^[A-Z0-9_]+#$/.test(text)) return false;
  return true;
}

function listSources(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      if (!/^(node_modules|__fixtures__|__pycache__|i18n)$/.test(name)) listSources(full, out);
    } else if (/\.(jsx?|tsx?)$/.test(name) && !/\.test\./.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function extract() {
  const found = new Set();
  const add = (raw) => {
    const text = normalize(raw);
    if (isHumanText(text)) found.add(text);
  };
  for (const file of listSources(ROOT)) {
    let ast;
    try {
      ast = parser.parse(fs.readFileSync(file, 'utf8'), {
        sourceType: 'module',
        plugins: ['jsx', 'typescript'],
      });
    } catch (error) {
      console.warn(`[i18n] ignoré ${path.relative(ROOT, file)} : ${error.message}`);
      continue;
    }
    traverse(ast, {
      JSXText(p) { add(p.node.value); },
      JSXAttribute(p) {
        const name = p.node.name && p.node.name.name;
        if (ATTRS.has(name) && p.node.value && p.node.value.type === 'StringLiteral') add(p.node.value.value);
      },
      ObjectProperty(p) {
        const key = p.node.key && (p.node.key.name || p.node.key.value);
        if (DATA_KEYS.has(key) && p.node.value.type === 'StringLiteral') add(p.node.value.value);
      },
      JSXExpressionContainer(p) {
        p.traverse({
          StringLiteral(q) {
            if (q.parent.type === 'JSXAttribute' || q.parent.type === 'ImportDeclaration') return;
            if (q.parent.type === 'ObjectProperty' && q.parent.key === q.node) return;
            const value = q.node.value;
            if (/\s/.test(value.trim()) || /^[A-ZÀ-Ý]/.test(value)) add(value);
          },
        });
      },
    });
  }
  return [...found].sort((a, b) => a.localeCompare(b, 'fr'));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

const keys = extract();
const fr = {};
for (const key of keys) fr[key] = key;
if (!process.argv.includes('--check')) {
  fs.mkdirSync(LOCALES, { recursive: true });
  fs.writeFileSync(path.join(LOCALES, 'fr.json'), `${JSON.stringify(fr, null, 2)}\n`);
}
console.log(`[i18n] ${keys.length} textes français.`);
for (const lang of ['en', 'ta']) {
  const dict = readJson(path.join(LOCALES, `${lang}.json`));
  const missing = keys.filter((key) => !dict[key]);
  console.log(`[i18n] ${lang}.json : ${keys.length - missing.length} traduits, ${missing.length} manquants.`);
}
