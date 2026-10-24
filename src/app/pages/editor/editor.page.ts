import { Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewInit, NgZone } from '@angular/core';
import { CommonModule, AsyncPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonIcon, IonInput, IonModal, IonSpinner, ToastController, AlertController } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  folderOutline, documentOutline, addOutline, trashOutline, playOutline, saveOutline,
  sparklesOutline, terminalOutline, eyeOutline, chevronBackOutline, chevronForwardOutline,
  chevronUpOutline, chevronDownOutline, settingsOutline, closeOutline, codeSlashOutline,
  refreshOutline, folderOpenOutline, checkmarkOutline, bugOutline
} from 'ionicons/icons';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import 'monaco-editor/esm/vs/language/json/monaco.contribution';
import { FilesystemService, FileEntry } from '../../services/filesystem.service';
import { AiVisionService, AiContext, AiMessage, AiFix, AI_PROVIDERS, AiProvider } from '../../services/ai-vision.service';
import { Subscription } from 'rxjs';

interface EditorTab {
  id: string; path: string; name: string; content: string; language: string; dirty: boolean;
  model?: monaco.editor.ITextModel;
}

@Component({
  selector: 'app-editor',
  templateUrl: './editor.page.html',
  styleUrls: ['./editor.page.scss'],
  standalone: true,
  imports: [CommonModule, AsyncPipe, FormsModule, IonIcon, IonInput, IonModal, IonSpinner]
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
  bottomPanel: 'terminal' | 'preview' | 'none' = 'none';
  terminalOutput = '';
  aiPanelOpen = false;
  aiInput = '';
  settingsOpen = false;
  apiKeyInput = '';
  geminiKeyInput = '';
  selectedProvider: AiProvider = 'groq';
  selectedModel = AI_PROVIDERS.groq.defaultModel;
  availableModels: string[] = AI_PROVIDERS.groq.models;
  autoDebug = false;
  isAiProcessing = false;
  messages: AiMessage[] = [];
  lastFix: AiFix | null = null;
  showNewFileModal = false;
  newFileName = '';
  isFolder = false;
  pyodide: any = null;
  pyodideReady = false;

  readonly symbols = ['{', '}', '(', ')', '[', ']', '<', '>', '=', '"', "'", ':', ';', '.', ',', '/', '\\', '#'];

  private subs: Subscription[] = [];
  private contentChangeDisposable: monaco.IDisposable | null = null;
  private suggestTimer: any = null;

  constructor(
    private fs: FilesystemService,
    public ai: AiVisionService,
    private toast: ToastController,
    private alert: AlertController,
    private zone: NgZone
  ) {
    addIcons({
      folderOutline, documentOutline, addOutline, trashOutline, playOutline, saveOutline,
      sparklesOutline, terminalOutline, eyeOutline, chevronBackOutline, chevronForwardOutline,
      chevronUpOutline, chevronDownOutline, settingsOutline, closeOutline, codeSlashOutline,
      refreshOutline, folderOpenOutline, checkmarkOutline, bugOutline
    });
  }

  async ngOnInit() {
    await this.fs.init();
    await this.refreshFiles();
    this.selectedProvider = this.ai.getProvider();
    this.selectedModel = this.ai.getModel();
    this.availableModels = AI_PROVIDERS[this.selectedProvider].models;
    this.subs.push(
      this.ai.messages$.subscribe(m => this.messages = m),
      this.ai.isProcessing$.subscribe(p => this.isAiProcessing = p),
      this.ai.lastFix$.subscribe(f => this.lastFix = f),
      this.ai.autoDebugMode$.subscribe(a => this.autoDebug = a)
    );
    if (!(await this.fs.listFiles()).length) {
      await this.createDemoProject();
      await this.refreshFiles();
    }
  }

  ngAfterViewInit() { setTimeout(() => this.initMonaco(), 150); }

  ngOnDestroy() {
    this.subs.forEach(s => s.unsubscribe());
    clearTimeout(this.suggestTimer);
    this.contentChangeDisposable?.dispose();
    this.editor?.dispose();
  }

  private async createDemoProject() {
    await this.fs.createFile('index.html', '<!DOCTYPE html><html><head><title>Zeno</title><link rel="stylesheet" href="style.css"></head><body><h1>Zeno Editor</h1><button id="btn">Click</button><script src="app.js"></script></body></html>');
    await this.fs.createFile('style.css', 'body{font-family:system-ui;background:#0e0e10;color:#eee}h1{color:#00ff88}');
    await this.fs.createFile('app.js', "document.getElementById('btn')?.addEventListener('click',()=>alert('Hello'));");
    await this.fs.createFile('main.py', 'print("Hello from Zeno")');
  }

  private initMonaco() {
    if (!this.editorContainer?.nativeElement) return;
    (self as any).MonacoEnvironment = {
      getWorkerUrl: (_: string, label: string) => {
        const b = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs';
        if (label === 'json') return b + '/language/json/json.worker.js';
        if (label === 'css' || label === 'scss') return b + '/language/css/css.worker.js';
        if (label === 'html') return b + '/language/html/html.worker.js';
        if (label === 'typescript' || label === 'javascript') return b + '/language/typescript/ts.worker.js';
        return b + '/editor/editor.worker.js';
      }
    };

    this.editor = monaco.editor.create(this.editorContainer.nativeElement, {
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 14,
      lineHeight: 22,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      lineNumbers: 'on',
      lineNumbersMinChars: 3,
      scrollBeyondLastLine: false,
      cursorStyle: 'line',
      cursorBlinking: 'blink',
      wordWrap: 'on',
      tabSize: 2,
      renderLineHighlight: 'all',
      matchBrackets: 'near',
      folding: false,
      glyphMargin: false,
      overviewRulerLanes: 0,
      scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6, useShadows: false },
      suggestOnTriggerCharacters: true,
      quickSuggestions: { other: true, comments: false, strings: true },
      quickSuggestionsDelay: 60,
      suggestSelection: 'first',
      tabCompletion: 'on',
      wordBasedSuggestions: 'currentDocument',
      snippetSuggestions: 'top',
      acceptSuggestionOnEnter: 'on',
      acceptSuggestionOnCommitCharacter: true,
      parameterHints: { enabled: true },
      hover: { enabled: false },
      links: false,
      contextmenu: true,
      smoothScrolling: false,
      mouseWheelZoom: false,
      dragAndDrop: false,
      padding: { top: 4, bottom: 8 }
    });

    this.contentChangeDisposable = this.editor.onDidChangeModelContent(() => {
      const tab = this.getActiveTab();
      if (tab && this.editor) {
        tab.content = this.editor.getValue();
        tab.dirty = true;
        this.ai.onEditorContentChange(() => this.buildContext());
      }
      clearTimeout(this.suggestTimer);
      this.suggestTimer = setTimeout(() => {
        if (!this.editor) return;
        const model = this.editor.getModel();
        const pos = this.editor.getPosition();
        if (!model || !pos) return;
        const w = model.getWordUntilPosition(pos);
        if (w.word && w.word.length >= 1) {
          this.editor.trigger('keyboard', 'editor.action.triggerSuggest', {});
        }
      }, 100);
    });

    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => this.saveCurrent());
    this.registerCompletions();

    if (this.files.length && !this.tabs.length) {
      const first = this.files.find(f => !f.isDirectory);
      if (first) this.openFile(first);
    }
  }

  private registerCompletions() {
    const Kind = monaco.languages.CompletionItemKind;
    const Snip = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
    const letters = 'abcdefghijklmnopqrstuvwxyz_'.split('');
    const mk = (items: any[]) => ({
      triggerCharacters: ['.', '<', ' ', ...letters],
      provideCompletionItems: (model: monaco.editor.ITextModel, pos: monaco.Position) => {
        const w = model.getWordUntilPosition(pos);
        const prefix = (w.word || '').toLowerCase();
        const range = {
          startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber,
          startColumn: w.startColumn, endColumn: w.endColumn
        };
        const filtered = prefix
          ? items.filter(it => String(it.label).toLowerCase().includes(prefix))
          : items;
        return {
          suggestions: filtered.map(it => ({
            ...it, range,
            sortText: String(it.label).toLowerCase().startsWith(prefix) ? '0' + it.label : '1' + it.label
          }))
        };
      }
    });

    const js = [
      { label: 'const', kind: Kind.Snippet, insertText: 'const ${1:name} = ${2:value};', insertTextRules: Snip, detail: 'snippet' },
      { label: 'let', kind: Kind.Snippet, insertText: 'let ${1:name} = ${2:value};', insertTextRules: Snip, detail: 'snippet' },
      { label: 'function', kind: Kind.Snippet, insertText: 'function ${1:name}(${2}) {\n  $0\n}', insertTextRules: Snip, detail: 'snippet' },
      { label: 'if', kind: Kind.Snippet, insertText: 'if (${1:cond}) {\n  $0\n}', insertTextRules: Snip, detail: 'snippet' },
      { label: 'for', kind: Kind.Snippet, insertText: 'for (let ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n  $0\n}', insertTextRules: Snip, detail: 'snippet' },
      { label: 'console.log', kind: Kind.Function, insertText: 'console.log(${1});', insertTextRules: Snip, detail: 'log' },
      { label: 'console', kind: Kind.Variable, insertText: 'console', detail: 'Console' },
      { label: 'document', kind: Kind.Variable, insertText: 'document' },
      { label: 'fetch', kind: Kind.Function, insertText: 'fetch(${1:url}).then(r => r.json()).then(${2:d} => {\n  $0\n})', insertTextRules: Snip },
      { label: 'try', kind: Kind.Snippet, insertText: 'try {\n  $0\n} catch (${1:e}) {\n  console.error(${1});\n}', insertTextRules: Snip },
      { label: 'async', kind: Kind.Snippet, insertText: 'async function ${1:name}(${2}) {\n  $0\n}', insertTextRules: Snip },
      { label: 'require', kind: Kind.Function, insertText: "require('${1}')", insertTextRules: Snip },
      { label: 'import', kind: Kind.Snippet, insertText: "import ${1} from '${2}';", insertTextRules: Snip },
      { label: 'export', kind: Kind.Keyword, insertText: 'export ' },
      { label: 'setTimeout', kind: Kind.Function, insertText: 'setTimeout(() => {\n  $0\n}, ${1:1000});', insertTextRules: Snip },
      { label: 'addEventListener', kind: Kind.Method, insertText: "addEventListener('${1:click}', (${2:e}) => {\n  $0\n});", insertTextRules: Snip },
      { label: 'querySelector', kind: Kind.Method, insertText: "document.querySelector('${1}')", insertTextRules: Snip },
      { label: 'getElementById', kind: Kind.Method, insertText: "document.getElementById('${1}')", insertTextRules: Snip },
    ];
    const html = [
      { label: 'div', kind: Kind.Snippet, insertText: '<div>$0</div>', insertTextRules: Snip },
      { label: 'span', kind: Kind.Snippet, insertText: '<span>$0</span>', insertTextRules: Snip },
      { label: 'p', kind: Kind.Snippet, insertText: '<p>$0</p>', insertTextRules: Snip },
      { label: 'a', kind: Kind.Snippet, insertText: '<a href="${1}">$0</a>', insertTextRules: Snip },
      { label: 'img', kind: Kind.Snippet, insertText: '<img src="${1}" alt="${2}" />', insertTextRules: Snip },
      { label: 'button', kind: Kind.Snippet, insertText: '<button type="button">$0</button>', insertTextRules: Snip },
      { label: 'input', kind: Kind.Snippet, insertText: '<input type="${1:text}" name="${2}" />', insertTextRules: Snip },
      { label: 'textarea', kind: Kind.Snippet, insertText: '<textarea name="${1}">$0</textarea>', insertTextRules: Snip, detail: 'emmet' },
      { label: 'script', kind: Kind.Snippet, insertText: '<script>\n  $0\n</script>', insertTextRules: Snip },
      { label: 'style', kind: Kind.Snippet, insertText: '<style>\n  $0\n</style>', insertTextRules: Snip },
      { label: 'class', kind: Kind.Property, insertText: 'class="${1}"', insertTextRules: Snip },
      { label: 'id', kind: Kind.Property, insertText: 'id="${1}"', insertTextRules: Snip },
      { label: 'Text', kind: Kind.Variable, insertText: 'Text', detail: 'DOM' },
    ];
    const css = [
      { label: 'display', kind: Kind.Property, insertText: 'display: ${1:flex};', insertTextRules: Snip },
      { label: 'flex', kind: Kind.Snippet, insertText: 'display: flex;\njustify-content: ${1:center};\nalign-items: ${2:center};', insertTextRules: Snip },
      { label: 'margin', kind: Kind.Property, insertText: 'margin: ${1:0};', insertTextRules: Snip },
      { label: 'padding', kind: Kind.Property, insertText: 'padding: ${1:0};', insertTextRules: Snip },
      { label: 'color', kind: Kind.Property, insertText: 'color: ${1:#00ff88};', insertTextRules: Snip },
      { label: 'background', kind: Kind.Property, insertText: 'background: ${1:#0e0e10};', insertTextRules: Snip },
      { label: 'media', kind: Kind.Snippet, insertText: '@media (max-width: ${1:600px}) {\n  $0\n}', insertTextRules: Snip },
    ];
    const py = [
      { label: 'def', kind: Kind.Snippet, insertText: 'def ${1:name}(${2}):\n    $0', insertTextRules: Snip },
      { label: 'class', kind: Kind.Snippet, insertText: 'class ${1:Name}:\n    def __init__(self):\n        $0', insertTextRules: Snip },
      { label: 'if', kind: Kind.Snippet, insertText: 'if ${1:cond}:\n    $0', insertTextRules: Snip },
      { label: 'for', kind: Kind.Snippet, insertText: 'for ${1:i} in ${2:range(10)}:\n    $0', insertTextRules: Snip },
      { label: 'print', kind: Kind.Function, insertText: 'print(${1})', insertTextRules: Snip },
      { label: 'import', kind: Kind.Snippet, insertText: 'import ${1}', insertTextRules: Snip },
      { label: 'try', kind: Kind.Snippet, insertText: 'try:\n    $0\nexcept Exception as e:\n    print(e)', insertTextRules: Snip },
    ];
    monaco.languages.registerCompletionItemProvider('javascript', mk(js));
    monaco.languages.registerCompletionItemProvider('typescript', mk(js));
    monaco.languages.registerCompletionItemProvider('html', mk(html));
    monaco.languages.registerCompletionItemProvider('css', mk(css));
    monaco.languages.registerCompletionItemProvider('python', mk(py));
  }

  triggerSuggest() {
    if (!this.editor) return;
    this.editor.focus();
    this.editor.trigger('keyboard', 'editor.action.triggerSuggest', {});
  }

  moveCursor(dir: 'up' | 'down' | 'left' | 'right' | 'home') {
    if (!this.editor) return;
    const pos = this.editor.getPosition();
    if (!pos) return;
    const model = this.editor.getModel();
    if (!model) return;
    let { lineNumber, column } = pos;
    const maxLine = model.getLineCount();
    switch (dir) {
      case 'up': lineNumber = Math.max(1, lineNumber - 1); column = Math.min(column, model.getLineMaxColumn(lineNumber)); break;
      case 'down': lineNumber = Math.min(maxLine, lineNumber + 1); column = Math.min(column, model.getLineMaxColumn(lineNumber)); break;
      case 'left':
        if (column > 1) column -= 1;
        else if (lineNumber > 1) { lineNumber -= 1; column = model.getLineMaxColumn(lineNumber); }
        break;
      case 'right': {
        const maxCol = model.getLineMaxColumn(lineNumber);
        if (column < maxCol) column += 1;
        else if (lineNumber < maxLine) { lineNumber += 1; column = 1; }
        break;
      }
      case 'home': column = 1; break;
    }
    this.editor.setPosition({ lineNumber, column });
    this.editor.revealPositionInCenterIfOutsideViewport({ lineNumber, column });
    this.editor.focus();
  }

  insertSymbol(sym: string) {
    if (!this.editor) return;
    const sel = this.editor.getSelection();
    if (!sel) return;
    this.editor.executeEdits('symbol', [{ range: sel, text: sym, forceMoveMarkers: true }]);
    this.editor.focus();
  }

  private getLanguage(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase() || '';
    const map: Record<string, string> = {
      html: 'html', htm: 'html', css: 'css', scss: 'scss',
      js: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'typescript',
      json: 'json', py: 'python', md: 'markdown', xml: 'xml', svg: 'xml'
    };
    return map[ext] || 'plaintext';
  }

  async refreshFiles() { this.files = await this.fs.listFiles(this.currentDir); }

  async openFile(entry: FileEntry) {
    if (entry.isDirectory) { this.currentDir = entry.path; await this.refreshFiles(); return; }
    let tab = this.tabs.find(t => t.path === entry.path);
    if (tab) { this.activateTab(tab.id); return; }
    const content = await this.fs.readFile(entry.path);
    tab = { id: 'tab_' + Date.now(), path: entry.path, name: entry.name, content, language: this.getLanguage(entry.path), dirty: false };
    this.tabs.push(tab);
    this.activateTab(tab.id);
  }

  activateTab(id: string) {
    this.activeTabId = id;
    const tab = this.tabs.find(t => t.id === id);
    if (!tab || !this.editor) return;
    if (!tab.model) tab.model = monaco.editor.createModel(tab.content, tab.language);
    else if (tab.model.getValue() !== tab.content) tab.model.setValue(tab.content);
    this.editor.setModel(tab.model);
    this.editor.focus();
  }

  closeTab(id: string, event?: Event) {
    event?.stopPropagation();
    const idx = this.tabs.findIndex(t => t.id === id);
    if (idx === -1) return;
    const tab = this.tabs[idx];
    if (tab.dirty) this.saveTab(tab);
    tab.model?.dispose();
    this.tabs.splice(idx, 1);
    if (this.activeTabId === id) {
      if (this.tabs.length) this.activateTab(this.tabs[Math.min(idx, this.tabs.length - 1)].id);
      else { this.activeTabId = null; this.editor?.setModel(null); }
    }
  }

  getActiveTab(): EditorTab | null { return this.tabs.find(t => t.id === this.activeTabId) || null; }
  async saveCurrent() { const tab = this.getActiveTab(); if (tab) await this.saveTab(tab); }

  async saveTab(tab: EditorTab) {
    if (this.editor && this.activeTabId === tab.id) tab.content = this.editor.getValue();
    await this.fs.writeFile(tab.path, tab.content);
    tab.dirty = false;
    this.showToast('Saved ' + tab.name);
  }

  async deleteEntry(entry: FileEntry, event: Event) {
    event.stopPropagation();
    const alert = await this.alert.create({
      header: 'Delete', message: `Delete ${entry.name}?`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Delete', role: 'destructive', handler: async () => {
          await this.fs.deleteFile(entry.path);
          const tab = this.tabs.find(t => t.path === entry.path);
          if (tab) this.closeTab(tab.id);
          await this.refreshFiles();
          this.showToast('Deleted');
        }}
      ]
    });
    await alert.present();
  }

  openNewFileModal(isFolder = false) { this.isFolder = isFolder; this.newFileName = ''; this.showNewFileModal = true; }

  async createNew() {
    if (!this.newFileName.trim()) return;
    const path = this.currentDir ? `${this.currentDir}/${this.newFileName}` : this.newFileName;
    if (this.isFolder) await this.fs.createFolder(path);
    else await this.fs.createFile(path, this.getTemplate(this.newFileName));
    this.showNewFileModal = false;
    await this.refreshFiles();
    if (!this.isFolder) {
      const entry = this.files.find(f => f.name === this.newFileName);
      if (entry) this.openFile(entry);
    }
  }

  private getTemplate(name: string): string {
    const ext = name.split('.').pop()?.toLowerCase();
    if (ext === 'html') return '<!DOCTYPE html>\n<html>\n<head><title>New</title></head>\n<body>\n</body>\n</html>\n';
    if (ext === 'css') return '/* styles */\n';
    if (ext === 'js') return '// JavaScript\n';
    if (ext === 'ts') return '// TypeScript\n';
    if (ext === 'py') return 'print("Hello")\n';
    if (ext === 'json') return '{\n}\n';
    return '';
  }

  goUp() {
    if (!this.currentDir) return;
    const parts = this.currentDir.split('/');
    parts.pop();
    this.currentDir = parts.join('/');
    this.refreshFiles();
  }

  private fmt(v: any): string {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }

  private runJavaScript(code: string): void {
    const logs: string[] = [];
    const push = (level: string, args: any[]) => {
      logs.push((level ? `[${level}] ` : '') + args.map(a => this.fmt(a)).join(' '));
    };
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    console.log = (...a: any[]) => { push('', a); orig.log.apply(console, a); };
    console.warn = (...a: any[]) => { push('warn', a); orig.warn.apply(console, a); };
    console.error = (...a: any[]) => { push('error', a); orig.error.apply(console, a); };
    console.info = (...a: any[]) => { push('info', a); orig.info.apply(console, a); };
    try {
      const fn = new Function('"use strict";\n' + code + '\n');
      const result = fn();
      if (result !== undefined) logs.push('=> ' + this.fmt(result));
      if (!logs.length) logs.push('(ran with no console output)');
      this.terminalOutput += logs.join('\n') + '\nDone\n';
    } catch (e: any) {
      this.terminalOutput += 'Error: ' + (e?.message || String(e)) + '\n';
    } finally {
      console.log = orig.log; console.warn = orig.warn; console.error = orig.error; console.info = orig.info;
    }
  }

  togglePreview() {
    if (this.bottomPanel === 'preview') { this.bottomPanel = 'none'; return; }
    const tab = this.getActiveTab();
    if (tab && (tab.language === 'javascript' || tab.language === 'typescript')) {
      this.bottomPanel = 'terminal';
      this.terminalOutput += `\n$ run ${tab.name}\n`;
      this.runJavaScript(tab.content);
      return;
    }
    this.bottomPanel = 'preview';
    this.updatePreview();
  }

  async updatePreview() {
    const tab = this.getActiveTab();
    if (!tab) return;
    let html = tab.language === 'html' ? tab.content : `<pre>${tab.content.replace(/</g,'<')}</pre>`;
    setTimeout(() => {
      const iframe = this.previewFrame?.nativeElement as HTMLIFrameElement | undefined;
      if (!iframe) return;
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc) return;
      doc.open(); doc.write(html); doc.close();
    }, 40);
  }

  async runCode() {
    const tab = this.getActiveTab();
    if (!tab) return;
    if (this.editor && this.activeTabId === tab.id) tab.content = this.editor.getValue();
    if (tab.language === 'html') { this.bottomPanel = 'preview'; this.updatePreview(); return; }
    this.bottomPanel = 'terminal';
    this.terminalOutput += `\n$ run ${tab.name}\n`;
    if (tab.language === 'javascript' || tab.language === 'typescript') this.runJavaScript(tab.content);
    else if (tab.language === 'python') await this.runPython(tab.content);
    else this.terminalOutput += `Cannot run ${tab.language}\n`;
  }

  private async loadPyodide() {
    try {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/pyodide/v0.23.4/full/pyodide.js';
      script.onload = async () => {
        this.pyodide = await (window as any).loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.23.4/full/' });
        this.pyodideReady = true;
        this.zone.run(() => { this.terminalOutput += 'Pyodide ready.\n'; });
      };
      document.head.appendChild(script);
    } catch { this.terminalOutput += 'Pyodide failed.\n'; }
  }

  private async runPython(code: string) {
    if (!this.pyodideReady) {
      if (!this.pyodide) this.loadPyodide();
      this.terminalOutput += 'Pyodide loading... press Run again shortly.\n';
      return;
    }
    try {
      this.pyodide.setStdout({ batched: (msg: string) => this.zone.run(() => { this.terminalOutput += msg + '\n'; }) });
      this.pyodide.setStderr({ batched: (msg: string) => this.zone.run(() => { this.terminalOutput += 'ERR: ' + msg + '\n'; }) });
      await this.pyodide.runPythonAsync(code);
      this.terminalOutput += 'Done\n';
    } catch (e: any) { this.terminalOutput += 'Python Error: ' + (e.message || e) + '\n'; }
  }

  clearTerminal() { this.terminalOutput = ''; }
  toggleAiPanel() { this.aiPanelOpen = !this.aiPanelOpen; }

  buildContext(): AiContext {
    const tab = this.getActiveTab();
    let markers: any[] = [];
    if (this.editor && tab?.model) markers = monaco.editor.getModelMarkers({ resource: tab.model.uri });
    return {
      context: 'Full project', currentFile: tab?.path || '',
      currentCode: tab?.content || this.editor?.getValue() || '',
      errorMarkers: markers, terminalOutput: this.terminalOutput.slice(-2000),
      userGoal: this.aiInput || 'analyze and fix'
    };
  }

  async sendAiMessage() {
    if (!this.aiInput.trim() || this.isAiProcessing) return;
    const msg = this.aiInput.trim(); this.aiInput = '';
    await this.ai.askAi(msg, this.buildContext());
  }

  async applyFix() {
    if (!this.lastFix || !this.editor) return;
    if (this.getActiveTab()?.path !== this.lastFix.file) {
      const t = this.tabs.find(x => x.path === this.lastFix!.file);
      if (t) this.activateTab(t.id);
    }
    this.editor.executeEdits('ai-fix', [{ range: this.editor.getModel()!.getFullModelRange(), text: this.lastFix.fixed }]);
    const active = this.getActiveTab();
    if (active) { active.content = this.lastFix.fixed; active.dirty = true; }
    this.showToast('AI Fix Applied');
    this.ai.lastFix$.next(null);
  }

  toggleAutoDebug() {
    this.ai.toggleAutoDebug();
    this.showToast(this.autoDebug ? 'Auto Debug OFF' : 'Auto Debug ON');
  }

  onProviderChange(p: AiProvider) {
    this.selectedProvider = p;
    this.availableModels = AI_PROVIDERS[p].models;
    this.selectedModel = AI_PROVIDERS[p].defaultModel;
  }

  openSettings() {
    this.selectedProvider = this.ai.getProvider();
    this.selectedModel = this.ai.getModel();
    this.availableModels = AI_PROVIDERS[this.selectedProvider].models;
    this.apiKeyInput = localStorage.getItem('zeno_ai_key') || '';
    this.geminiKeyInput = localStorage.getItem('zeno_gemini_key') || '';
    this.settingsOpen = true;
  }

  saveSettings() {
    this.ai.setProvider(this.selectedProvider);
    this.ai.setModel(this.selectedModel);
    if (this.selectedProvider === 'gemini') this.ai.setGeminiKey(this.geminiKeyInput);
    else this.ai.setApiKey(this.apiKeyInput);
    this.settingsOpen = false;
    this.showToast('Saved: ' + this.selectedProvider);
  }

  private async showToast(msg: string) {
    const t = await this.toast.create({ message: msg, duration: 1600, position: 'bottom', color: 'dark' });
    await t.present();
  }
}
