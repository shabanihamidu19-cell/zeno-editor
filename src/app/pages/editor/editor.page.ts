import { Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewInit, NgZone } from '@angular/core';
import { CommonModule, AsyncPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonIcon,
  IonContent, IonList, IonItem, IonLabel, IonInput, IonTextarea,
  IonFab, IonFabButton, IonModal, IonToggle, IonBadge, IonChip,
  IonSplitPane, IonMenu, IonMenuToggle, ToastController, AlertController,
  IonSegment, IonSegmentButton, IonFooter, IonSpinner
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  folderOutline, documentOutline, addOutline, trashOutline, createOutline,
  playOutline, saveOutline, sparklesOutline, terminalOutline, eyeOutline,
  chevronBackOutline, chevronForwardOutline, settingsOutline, closeOutline,
  codeSlashOutline, refreshOutline, downloadOutline, folderOpenOutline,
  ellipsisVerticalOutline, checkmarkOutline, bugOutline
} from 'ionicons/icons';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { FilesystemService, FileEntry } from '../../services/filesystem.service';
import { AiVisionService, AiContext, AiMessage, AiFix } from '../../services/ai-vision.service';
import { Subscription } from 'rxjs';

interface EditorTab {
  id: string;
  path: string;
  name: string;
  content: string;
  language: string;
  dirty: boolean;
  model?: monaco.editor.ITextModel;
}

@Component({
  selector: 'app-editor',
  templateUrl: './editor.page.html',
  styleUrls: ['./editor.page.scss'],
  standalone: true,
  imports: [
    CommonModule, AsyncPipe, FormsModule,
    IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonIcon,
    IonContent, IonList, IonItem, IonLabel, IonInput, IonTextarea,
    IonFab, IonFabButton, IonModal, IonToggle, IonBadge, IonChip,
    IonSegment, IonSegmentButton, IonFooter, IonSpinner
  ]
})
export class EditorPage implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('editorContainer', { static: false }) editorContainer!: ElementRef;
  @ViewChild('previewFrame', { static: false }) previewFrame!: ElementRef;

  editor: monaco.editor.IStandaloneCodeEditor | null = null;
  tabs: EditorTab[] = [];
  activeTabId: string | null = null;
  files: FileEntry[] = [];
  currentDir = '';
  projectName = 'My Project';
  sidebarOpen = true;
  bottomPanel: 'terminal' | 'preview' | 'none' = 'terminal';
  terminalOutput = '';
  previewHtml = '';
  aiPanelOpen = false;
  aiInput = '';
  settingsOpen = false;
  apiKeyInput = '';
  apiEndpointInput = 'https://api.openai.com/v1/chat/completions';
  autoDebug = false;
  isAiProcessing = false;
  messages: AiMessage[] = [];
  lastFix: AiFix | null = null;
  showNewFileModal = false;
  newFileName = '';
  isFolder = false;
  pyodide: any = null;
  pyodideReady = false;

  private subs: Subscription[] = [];
  private contentChangeDisposable: monaco.IDisposable | null = null;
  private markerDisposable: monaco.IDisposable | null = null;

  constructor(
    private fs: FilesystemService,
    public ai: AiVisionService,
    private toast: ToastController,
    private alert: AlertController,
    private zone: NgZone
  ) {
    addIcons({
      folderOutline, documentOutline, addOutline, trashOutline, createOutline,
      playOutline, saveOutline, sparklesOutline, terminalOutline, eyeOutline,
      chevronBackOutline, chevronForwardOutline, settingsOutline, closeOutline,
      codeSlashOutline, refreshOutline, downloadOutline, folderOpenOutline,
      ellipsisVerticalOutline, checkmarkOutline, bugOutline
    });
  }

  async ngOnInit() {
    await this.fs.init();
    await this.refreshFiles();
    this.subs.push(
      this.ai.messages$.subscribe(m => this.messages = m),
      this.ai.isProcessing$.subscribe(p => this.isAiProcessing = p),
      this.ai.lastFix$.subscribe(f => this.lastFix = f),
      this.ai.autoDebugMode$.subscribe(a => this.autoDebug = a)
    );

    const list = await this.fs.listFiles();
    if (list.length === 0) {
      await this.createDemoProject();
      await this.refreshFiles();
    }
  }

  ngAfterViewInit() {
    setTimeout(() => this.initMonaco(), 100);
    this.loadPyodide();
  }

  ngOnDestroy() {
    this.subs.forEach(s => s.unsubscribe());
    this.contentChangeDisposable?.dispose();
    this.markerDisposable?.dispose();
    this.editor?.dispose();
  }

  private async createDemoProject() {
    await this.fs.createFile('index.html', `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>Zeno Demo</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <h1>Welcome to Zeno Editor</h1>\n  <p>AI-Powered Code Editor</p>\n  <button id="btn">Click me</button>\n  <script src="app.js"></script>\n</body>\n</html>`);
    await this.fs.createFile('style.css', `body {\n  font-family: system-ui, sans-serif;\n  background: #0e0e10;\n  color: #e0e0e0;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  justify-content: center;\n  min-height: 100vh;\n  margin: 0;\n}\nh1 { color: #00ff88; }\nbutton {\n  background: #00ff88;\n  color: #000;\n  border: none;\n  padding: 12px 24px;\n  border-radius: 8px;\n  font-size: 16px;\n  cursor: pointer;\n}`);
    await this.fs.createFile('app.js', `document.getElementById('btn').addEventListener('click', () => {\n  alert('Hello from Zeno Editor!');\n  console.log('Button clicked at', new Date().toISOString());\n});`);
    await this.fs.createFile('main.py', `print("Hello from Zeno Python!")\nfor i in range(5):\n    print(f"Count: {i}")\n`);
  }

  private initMonaco() {
    if (!this.editorContainer?.nativeElement) return;

    (self as any).MonacoEnvironment = {
      getWorkerUrl: function (_moduleId: string, label: string) {
        const base = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs';
        if (label === 'json') return base + '/language/json/json.worker.js';
        if (label === 'css' || label === 'scss' || label === 'less') return base + '/language/css/css.worker.js';
        if (label === 'html' || label === 'handlebars' || label === 'razor') return base + '/language/html/html.worker.js';
        if (label === 'typescript' || label === 'javascript') return base + '/language/typescript/ts.worker.js';
        return base + '/editor/editor.worker.js';
      }
    };

    this.editor = monaco.editor.create(this.editorContainer.nativeElement, {
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: true },
      fontSize: 14,
      lineNumbers: 'on',
      roundedSelection: true,
      scrollBeyondLastLine: false,
      readOnly: false,
      cursorStyle: 'line',
      wordWrap: 'on',
      tabSize: 2,
      renderWhitespace: 'selection',
      suggestOnTriggerCharacters: true,
      quickSuggestions: true,
      folding: true,
      glyphMargin: true
    });

    this.contentChangeDisposable = this.editor.onDidChangeModelContent(() => {
      const tab = this.getActiveTab();
      if (tab && this.editor) {
        tab.content = this.editor.getValue();
        tab.dirty = true;
        this.ai.onEditorContentChange(() => this.buildContext());
        if (this.bottomPanel === 'preview' && this.isPreviewable(tab)) {
          this.updatePreview();
        }
      }
    });

    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      this.saveCurrent();
    });

    if (this.files.length && !this.tabs.length) {
      const first = this.files.find(f => !f.isDirectory);
      if (first) this.openFile(first);
    }
  }

  private getLanguage(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase() || '';
    const map: Record<string, string> = {
      html: 'html', htm: 'html',
      css: 'css', scss: 'scss',
      js: 'javascript', mjs: 'javascript',
      ts: 'typescript', tsx: 'typescript',
      json: 'json',
      py: 'python',
      md: 'markdown',
      xml: 'xml', svg: 'xml'
    };
    return map[ext] || 'plaintext';
  }

  async refreshFiles() {
    this.files = await this.fs.listFiles(this.currentDir);
  }

  async openFile(entry: FileEntry) {
    if (entry.isDirectory) {
      this.currentDir = entry.path;
      await this.refreshFiles();
      return;
    }
    let tab = this.tabs.find(t => t.path === entry.path);
    if (tab) {
      this.activateTab(tab.id);
      return;
    }
    const content = await this.fs.readFile(entry.path);
    const id = 'tab_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    tab = {
      id,
      path: entry.path,
      name: entry.name,
      content,
      language: this.getLanguage(entry.path),
      dirty: false
    };
    this.tabs.push(tab);
    this.activateTab(id);
  }

  activateTab(id: string) {
    this.activeTabId = id;
    const tab = this.tabs.find(t => t.id === id);
    if (!tab || !this.editor) return;

    if (!tab.model) {
      tab.model = monaco.editor.createModel(tab.content, tab.language);
    } else {
      if (tab.model.getValue() !== tab.content) {
        tab.model.setValue(tab.content);
      }
    }
    this.editor.setModel(tab.model);
    this.editor.focus();
  }

  closeTab(id: string, event?: Event) {
    event?.stopPropagation();
    const idx = this.tabs.findIndex(t => t.id === id);
    if (idx === -1) return;
    const tab = this.tabs[idx];
    if (tab.dirty) {
      this.saveTab(tab);
    }
    tab.model?.dispose();
    this.tabs.splice(idx, 1);
    if (this.activeTabId === id) {
      if (this.tabs.length) {
        const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
        this.activateTab(next.id);
      } else {
        this.activeTabId = null;
        this.editor?.setModel(null);
      }
    }
  }

  getActiveTab(): EditorTab | null {
    return this.tabs.find(t => t.id === this.activeTabId) || null;
  }

  async saveCurrent() {
    const tab = this.getActiveTab();
    if (!tab) return;
    await this.saveTab(tab);
  }

  async saveTab(tab: EditorTab) {
    if (this.editor && this.activeTabId === tab.id) {
      tab.content = this.editor.getValue();
    }
    await this.fs.writeFile(tab.path, tab.content);
    tab.dirty = false;
    this.showToast('Saved ' + tab.name);
  }

  async saveAll() {
    for (const tab of this.tabs) {
      await this.saveTab(tab);
    }
  }

  async deleteEntry(entry: FileEntry, event: Event) {
    event.stopPropagation();
    const alert = await this.alert.create({
      header: 'Delete',
      message: `Delete ${entry.name}?`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Delete', role: 'destructive',
          handler: async () => {
            await this.fs.deleteFile(entry.path);
            const tab = this.tabs.find(t => t.path === entry.path);
            if (tab) this.closeTab(tab.id);
            await this.refreshFiles();
            this.showToast('Deleted');
          }
        }
      ]
    });
    await alert.present();
  }

  openNewFileModal(isFolder = false) {
    this.isFolder = isFolder;
    this.newFileName = '';
    this.showNewFileModal = true;
  }

  async createNew() {
    if (!this.newFileName.trim()) return;
    const path = this.currentDir ? `${this.currentDir}/${this.newFileName}` : this.newFileName;
    if (this.isFolder) {
      await this.fs.createFolder(path);
    } else {
      const content = this.getTemplate(this.newFileName);
      await this.fs.createFile(path, content);
    }
    this.showNewFileModal = false;
    await this.refreshFiles();
    if (!this.isFolder) {
      const entry = this.files.find(f => f.name === this.newFileName);
      if (entry) this.openFile(entry);
    }
  }

  private getTemplate(name: string): string {
    const ext = name.split('.').pop()?.toLowerCase();
    if (ext === 'html') return '<!DOCTYPE html>\n<html>\n<head>\n  <title>New Page</title>\n</head>\n<body>\n  \n</body>\n</html>';
    if (ext === 'css') return '/* styles */\n';
    if (ext === 'js') return '// JavaScript\n';
    if (ext === 'ts') return '// TypeScript\n';
    if (ext === 'py') return '# Python\nprint("Hello")\n';
    if (ext === 'json') return '{\n  \n}\n';
    return '';
  }

  goUp() {
    if (!this.currentDir) return;
    const parts = this.currentDir.split('/');
    parts.pop();
    this.currentDir = parts.join('/');
    this.refreshFiles();
  }

  isPreviewable(tab: EditorTab | null): boolean {
    if (!tab) return false;
    return ['html', 'htm', 'css', 'js'].includes(tab.path.split('.').pop()?.toLowerCase() || '');
  }

  togglePreview() {
    if (this.bottomPanel === 'preview') {
      this.bottomPanel = 'terminal';
    } else {
      this.bottomPanel = 'preview';
      this.updatePreview();
    }
  }

  async updatePreview() {
    const tab = this.getActiveTab();
    if (!tab) return;
    let html = '';
    let css = '';
    let js = '';

    const all = await this.fs.getAllProjectFiles(this.currentDir || '');
    for (const f of all) {
      const ext = f.path.split('.').pop()?.toLowerCase();
      if (ext === 'html' || ext === 'htm') {
        if (f.path === tab.path || !html) html = f.content;
      } else if (ext === 'css') {
        css += f.content + '\n';
      } else if (ext === 'js') {
        js += f.content + '\n';
      }
    }
    if (!html && tab.language === 'html') html = tab.content;
    if (!html) {
      html = `<html><body><pre>${tab.content}</pre></body></html>`;
    }

    if (css) {
      html = html.replace('</head>', `<style>${css}</style></head>`);
      if (!html.includes('</head>')) html = `<style>${css}</style>` + html;
    }
    if (js) {
      html = html.replace('</body>', `<script>${js}</script></body>`);
      if (!html.includes('</body>')) html += `<script>${js}</script>`;
    }
    this.previewHtml = html;
    setTimeout(() => {
      const iframe = this.previewFrame?.nativeElement;
      if (iframe) {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc) {
          doc.open();
          doc.write(html);
          doc.close();
        }
      }
    }, 50);
  }

  async runCode() {
    const tab = this.getActiveTab();
    if (!tab) return;
    this.bottomPanel = 'terminal';
    this.terminalOutput += `\n$ run ${tab.name}\n`;

    if (tab.language === 'javascript' || tab.language === 'typescript') {
      try {
        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (...args: any[]) => {
          logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
          originalLog.apply(console, args);
        };
        const result = eval(tab.content);
        console.log = originalLog;
        if (logs.length) this.terminalOutput += logs.join('\n') + '\n';
        if (result !== undefined) this.terminalOutput += '=> ' + String(result) + '\n';
        this.terminalOutput += 'Process finished\n';
      } catch (e: any) {
        this.terminalOutput += 'Error: ' + (e.message || e) + '\n';
      }
    } else if (tab.language === 'python') {
      await this.runPython(tab.content);
    } else if (tab.language === 'html') {
      this.togglePreview();
      this.terminalOutput += 'Opened live preview\n';
    } else {
      this.terminalOutput += `Cannot execute ${tab.language} files directly.\n`;
    }
  }

  private async loadPyodide() {
    try {
      if ((window as any).loadPyodide) {
        this.pyodide = await (window as any).loadPyodide({
          indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.23.4/full/'
        });
        this.pyodideReady = true;
        this.terminalOutput += 'Pyodide ready.\n';
      } else {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/pyodide/v0.23.4/full/pyodide.js';
        script.onload = async () => {
          this.pyodide = await (window as any).loadPyodide({
            indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.23.4/full/'
          });
          this.pyodideReady = true;
          this.zone.run(() => {
            this.terminalOutput += 'Pyodide ready.\n';
          });
        };
        document.head.appendChild(script);
      }
    } catch (e) {
      console.error('Pyodide load failed', e);
      this.terminalOutput += 'Pyodide failed to load (offline?).\n';
    }
  }

  private async runPython(code: string) {
    if (!this.pyodideReady || !this.pyodide) {
      this.terminalOutput += 'Pyodide not ready yet. Wait a moment.\n';
      return;
    }
    try {
      this.pyodide.setStdout({
        batched: (msg: string) => {
          this.zone.run(() => { this.terminalOutput += msg + '\n'; });
        }
      });
      this.pyodide.setStderr({
        batched: (msg: string) => {
          this.zone.run(() => { this.terminalOutput += 'ERR: ' + msg + '\n'; });
        }
      });
      await this.pyodide.runPythonAsync(code);
      this.terminalOutput += 'Process finished\n';
    } catch (e: any) {
      this.terminalOutput += 'Python Error: ' + (e.message || e) + '\n';
    }
  }

  clearTerminal() {
    this.terminalOutput = '';
  }

  toggleAiPanel() {
    this.aiPanelOpen = !this.aiPanelOpen;
  }

  buildContext(): AiContext {
    const tab = this.getActiveTab();
    let markers: any[] = [];
    if (this.editor && tab?.model) {
      markers = monaco.editor.getModelMarkers({ resource: tab.model.uri });
    }
    return {
      context: 'Full project file list',
      currentFile: tab?.path || '',
      currentCode: tab?.content || this.editor?.getValue() || '',
      errorMarkers: markers,
      terminalOutput: this.terminalOutput.slice(-2000),
      userGoal: this.aiInput || 'analyze and fix'
    };
  }

  async sendAiMessage() {
    if (!this.aiInput.trim() || this.isAiProcessing) return;
    const msg = this.aiInput.trim();
    this.aiInput = '';
    const ctx = this.buildContext();
    await this.ai.askAi(msg, ctx);
  }

  async applyFix() {
    if (!this.lastFix || !this.editor) return;
    const tab = this.getActiveTab();
    if (!tab || tab.path !== this.lastFix.file) {
      const t = this.tabs.find(x => x.path === this.lastFix!.file);
      if (t) this.activateTab(t.id);
    }
    this.editor.executeEdits('ai-fix', [{
      range: this.editor.getModel()!.getFullModelRange(),
      text: this.lastFix.fixed
    }]);
    const active = this.getActiveTab();
    if (active) {
      active.content = this.lastFix.fixed;
      active.dirty = true;
    }
    this.showToast('AI Fix Applied');
    this.ai.lastFix$.next(null);
  }

  toggleAutoDebug() {
    this.ai.toggleAutoDebug();
    this.showToast(this.autoDebug ? 'Auto Debug OFF' : 'Auto Debug ON');
  }

  openSettings() {
    this.apiKeyInput = localStorage.getItem('zeno_ai_key') || '';
    this.apiEndpointInput = localStorage.getItem('zeno_ai_endpoint') || 'https://api.openai.com/v1/chat/completions';
    this.settingsOpen = true;
  }

  saveSettings() {
    this.ai.setApiKey(this.apiKeyInput);
    this.ai.setApiEndpoint(this.apiEndpointInput);
    this.settingsOpen = false;
    this.showToast('Settings saved');
  }

  private async showToast(msg: string) {
    const t = await this.toast.create({
      message: msg,
      duration: 2000,
      position: 'bottom',
      color: 'dark',
      cssClass: 'zeno-toast'
    });
    await t.present();
  }
}
