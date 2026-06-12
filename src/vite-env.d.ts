/// <reference types="vite/client" />

declare module 'espeak-ng' {
  interface EmscriptenFS {
    mkdir(path: string): void
    writeFile(path: string, data: string): void
    readFile(path: string, opts: { encoding: 'utf8' }): string
  }
  interface EmscriptenModule {
    FS: EmscriptenFS
  }
  interface ESpeakNgOptions {
    arguments?: string[]
    locateFile?: (path: string) => string
    preRun?: Array<(m: EmscriptenModule) => void>
  }
  const ESpeakNg: (opts: ESpeakNgOptions) => Promise<EmscriptenModule>
  export default ESpeakNg
}

declare module 'espeak-ng/dist/espeak-ng.wasm?url' {
  const url: string
  export default url
}

