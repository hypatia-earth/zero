declare module 'wgsl-edit' {
  export class WgslEdit extends HTMLElement {
    source: string;
    sources: Record<string, string>;
    activeFile: string;
    fileNames: string[];
    lint: string;
    project: {
      weslSrc?: Record<string, string>;
      rootModuleName?: string;
      libs?: Array<{ name: string; edition: string; modules: Record<string, string> }>;
      packageName?: string;
    };
    addFile(name: string, content?: string): void;
    removeFile(name: string): void;
    renameFile(oldName: string, newName: string): void;
  }
}
