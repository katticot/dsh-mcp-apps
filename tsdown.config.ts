import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')) as { version: string }

const define = {
  __PKG_VERSION__: JSON.stringify(pkg.version),
}

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node20',
    dts: true,
    outDir: 'lib',
    clean: true,
    sourcemap: false,
    define,
  },
  {
    entry: {
      client: 'src/client/index.tsx',
    },
    format: ['cjs'],
    target: 'es2022',
    dts: true,
    outDir: 'lib',
    clean: false,
    sourcemap: false,
    outputOptions: {
      entryFileNames: 'client.js',
    },
    noExternal: [/@modelcontextprotocol\/.*/, /zod/],
    banner: 'window.__ModuleLoader__.load({ id: "dsh-mcp-apps", factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
    define,
  },
])
