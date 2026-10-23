import { Injectable } from '@angular/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  mtime?: number;
}

@Injectable({
  providedIn: 'root'
})
export class FilesystemService {
  private rootDir = 'ZenoProjects';
  private basePath = '';

  constructor() {
    this.init();
  }

  async init(): Promise<void> {
    try {
      if (Capacitor.isNativePlatform()) {
        await this.ensureDir(this.rootDir);
        this.basePath = this.rootDir;
      } else {
        // Web fallback using localStorage for demo
        this.basePath = 'web';
      }
    } catch (e) {
      console.error('Filesystem init error', e);
    }
  }

  private async ensureDir(path: string): Promise<void> {
    try {
      await Filesystem.mkdir({
        path,
        directory: Directory.Documents,
        recursive: true
      });
    } catch (e: any) {
      if (!e.message?.includes('exists')) {
        // ignore if exists
      }
    }
  }

  async listFiles(relativePath: string = ''): Promise<FileEntry[]> {
    if (!Capacitor.isNativePlatform()) {
      return this.listWebFiles(relativePath);
    }
    try {
      const path = relativePath ? `${this.rootDir}/${relativePath}` : this.rootDir;
      const result = await Filesystem.readdir({
        path,
        directory: Directory.Documents
      });
      return (result.files || []).map(f => ({
        name: f.name,
        path: relativePath ? `${relativePath}/${f.name}` : f.name,
        isDirectory: f.type === 'directory',
        size: f.size,
        mtime: f.mtime
      })).sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });
    } catch (e) {
      console.error('listFiles error', e);
      return [];
    }
  }

  async readFile(relativePath: string): Promise<string> {
    if (!Capacitor.isNativePlatform()) {
      return this.readWebFile(relativePath);
    }
    try {
      const result = await Filesystem.readFile({
        path: `${this.rootDir}/${relativePath}`,
        directory: Directory.Documents,
        encoding: Encoding.UTF8
      });
      return result.data as string;
    } catch (e) {
      console.error('readFile error', e);
      return '';
    }
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      this.writeWebFile(relativePath, content);
      return;
    }
    try {
      // Ensure parent dirs
      const parts = relativePath.split('/');
      if (parts.length > 1) {
        const dir = parts.slice(0, -1).join('/');
        await this.ensureDir(`${this.rootDir}/${dir}`);
      }
      await Filesystem.writeFile({
        path: `${this.rootDir}/${relativePath}`,
        data: content,
        directory: Directory.Documents,
        encoding: Encoding.UTF8
      });
    } catch (e) {
      console.error('writeFile error', e);
      throw e;
    }
  }

  async deleteFile(relativePath: string): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      this.deleteWebFile(relativePath);
      return;
    }
    try {
      await Filesystem.deleteFile({
        path: `${this.rootDir}/${relativePath}`,
        directory: Directory.Documents
      });
    } catch (e) {
      // try as dir
      try {
        await Filesystem.rmdir({
          path: `${this.rootDir}/${relativePath}`,
          directory: Directory.Documents,
          recursive: true
        });
      } catch (e2) {
        console.error('delete error', e2);
        throw e2;
      }
    }
  }

  async renameFile(oldPath: string, newName: string): Promise<void> {
    const content = await this.readFile(oldPath);
    const parts = oldPath.split('/');
    parts[parts.length - 1] = newName;
    const newPath = parts.join('/');
    await this.writeFile(newPath, content);
    await this.deleteFile(oldPath);
  }

  async createFile(relativePath: string, content: string = ''): Promise<void> {
    await this.writeFile(relativePath, content);
  }

  async createFolder(relativePath: string): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      this.createWebFolder(relativePath);
      return;
    }
    await this.ensureDir(`${this.rootDir}/${relativePath}`);
  }

  async getAllProjectFiles(base: string = ''): Promise<{ path: string; content: string }[]> {
    const files: { path: string; content: string }[] = [];
    const entries = await this.listFiles(base);
    for (const e of entries) {
      if (e.isDirectory) {
        const sub = await this.getAllProjectFiles(e.path);
        files.push(...sub);
      } else {
        const content = await this.readFile(e.path);
        files.push({ path: e.path, content });
      }
    }
    return files;
  }

  // ========== WEB FALLBACK (localStorage) ==========
  private webStoreKey = 'zeno_fs';

  private getWebStore(): Record<string, string | null> {
    try {
      return JSON.parse(localStorage.getItem(this.webStoreKey) || '{}');
    } catch {
      return {};
    }
  }

  private setWebStore(store: Record<string, string | null>): void {
    localStorage.setItem(this.webStoreKey, JSON.stringify(store));
  }

  private listWebFiles(relativePath: string): FileEntry[] {
    const store = this.getWebStore();
    const prefix = relativePath ? relativePath + '/' : '';
    const entries: FileEntry[] = [];
    const seenDirs = new Set<string>();

    for (const key of Object.keys(store)) {
      if (!key.startsWith(prefix) && prefix !== '') continue;
      const rest = prefix ? key.slice(prefix.length) : key;
      if (!rest) continue;
      const parts = rest.split('/');
      if (parts.length === 1) {
        if (store[key] === null) {
          entries.push({ name: parts[0], path: key, isDirectory: true });
        } else {
          entries.push({ name: parts[0], path: key, isDirectory: false });
        }
      } else {
        const dirName = parts[0];
        if (!seenDirs.has(dirName)) {
          seenDirs.add(dirName);
          entries.push({ name: dirName, path: prefix + dirName, isDirectory: true });
        }
      }
    }
    return entries.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  private readWebFile(path: string): string {
    const store = this.getWebStore();
    return (store[path] as string) || '';
  }

  private writeWebFile(path: string, content: string): void {
    const store = this.getWebStore();
    store[path] = content;
    this.setWebStore(store);
  }

  private deleteWebFile(path: string): void {
    const store = this.getWebStore();
    delete store[path];
    // also delete children if dir
    for (const key of Object.keys(store)) {
      if (key.startsWith(path + '/')) delete store[key];
    }
    this.setWebStore(store);
  }

  private createWebFolder(path: string): void {
    const store = this.getWebStore();
    store[path] = null; // null means directory
    this.setWebStore(store);
  }
}
