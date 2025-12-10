declare module '@openmeteo/file-format-wasm' {
  export default function createModule(options?: { wasmBinary?: ArrayBuffer }): Promise<unknown>;
}
