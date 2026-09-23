import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node20',
    dts: true,
    outDir: 'lib',
    clean: true,
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
    outputOptions: {
      entryFileNames: 'client.js',
    },
    noExternal: [/@modelcontextprotocol\/.*/, /zod/],
    banner: 'window.__ModuleLoader__.load({ id: "dsh-mcp-apps", factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
])
