import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { FilesystemService } from './filesystem.service';

export interface AiContext {
  context: string;
  currentFile: string;
  currentCode: string;
  errorMarkers: any[];
  terminalOutput: string;
  userGoal: string;
  allFiles?: { path: string; content: string }[];
}

export interface AiMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  applied?: boolean;
}

export interface AiFix {
  file: string;
  original: string;
  fixed: string;
  explanation: string;
}

@Injectable({
  providedIn: 'root'
})
export class AiVisionService {
  private apiKey = '';
  private apiEndpoint = 'https://api.openai.com/v1/chat/completions';
  private model = 'gpt-4o-mini';

  autoDebugMode$ = new BehaviorSubject<boolean>(false);
  messages$ = new BehaviorSubject<AiMessage[]>([]);
  isProcessing$ = new BehaviorSubject<boolean>(false);
  lastFix$ = new BehaviorSubject<AiFix | null>(null);
  visionActive$ = new BehaviorSubject<boolean>(true);

  private contentChangeSubject = new Subject<void>();
  private debounceTimer: any;

  constructor(private fs: FilesystemService) {
    // Load saved API key
    const saved = localStorage.getItem('zeno_ai_key');
    if (saved) this.apiKey = saved;
    const endpoint = localStorage.getItem('zeno_ai_endpoint');
    if (endpoint) this.apiEndpoint = endpoint;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
    localStorage.setItem('zeno_ai_key', key);
  }

  setApiEndpoint(url: string): void {
    this.apiEndpoint = url;
    localStorage.setItem('zeno_ai_endpoint', url);
  }

  getApiKey(): string {
    return this.apiKey ? '••••' + this.apiKey.slice(-4) : '';
  }

  toggleAutoDebug(): void {
    this.autoDebugMode$.next(!this.autoDebugMode$.value);
  }

  onEditorContentChange(getContext: () => AiContext): void {
    if (!this.autoDebugMode$.value) return;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.runOfflineLinter(getContext());
    }, 1500);
  }

  // ========== LAYER 1: OFFLINE LINTER & AUTO-FIX ==========
  runOfflineLinter(ctx: AiContext): { fixed: boolean; message: string; newCode?: string } {
    const code = ctx.currentCode;
    const file = ctx.currentFile || '';
    const ext = file.split('.').pop()?.toLowerCase() || '';

    let result = { fixed: false, message: '', newCode: code };

    // Generic bracket / paren / brace balancer
    const openers = { '(': ')', '[': ']', '{': '}' };
    const stack: string[] = [];
    let inString = false;
    let stringChar = '';
    let inComment = false;
    let inLineComment = false;

    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      const next = code[i + 1];

      if (inLineComment) {
        if (ch === '\n') inLineComment = false;
        continue;
      }
      if (inComment) {
        if (ch === '*' && next === '/') { inComment = false; i++; }
        continue;
      }
      if (inString) {
        if (ch === '\\') { i++; continue; }
        if (ch === stringChar) inString = false;
        continue;
      }

      if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
      if (ch === '/' && next === '*') { inComment = true; i++; continue; }
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = true;
        stringChar = ch;
        continue;
      }

      if (ch in openers) stack.push((openers as any)[ch]);
      else if (Object.values(openers).includes(ch)) {
        if (stack.length && stack[stack.length - 1] === ch) stack.pop();
        else {
          // mismatch - could try to fix but risky
        }
      }
    }

    // Auto close missing braces/brackets at end of file for JS/TS/JSON/CSS
    if (stack.length > 0 && ['js', 'ts', 'tsx', 'jsx', 'json', 'css', 'html'].includes(ext)) {
      let addition = '';
      while (stack.length) {
        addition += stack.pop();
      }
      if (addition) {
        result.newCode = code + '\n' + addition;
        result.fixed = true;
        result.message = `AI Auto-Fixed: Added missing ${addition}`;
        return result;
      }
    }

    // HTML unclosed tags (simple)
    if (ext === 'html' || ext === 'htm') {
      const openTags = (code.match(/<([a-zA-Z][a-zA-Z0-9]*)[^>]*>(?![^<]*<\/\1>)/g) || [])
        .map(t => t.match(/<([a-zA-Z][a-zA-Z0-9]*)/)?.[1])
        .filter(Boolean) as string[];
      const selfClosing = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);
      const unclosed = openTags.filter(t => !selfClosing.has(t.toLowerCase()));
      // Very simplistic - only suggest, don't auto close complex HTML
    }

    // Python indentation / colon check (basic)
    if (ext === 'py') {
      const lines = code.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (/^(def|class|if|elif|else|for|while|try|except|finally|with)\b/.test(line) && !line.endsWith(':') && !line.endsWith('\\')) {
          // missing colon
          lines[i] = lines[i].replace(/\s*$/, ':');
          result.newCode = lines.join('\n');
          result.fixed = true;
          result.message = `AI Auto-Fixed: Added missing : on line ${i + 1}`;
          return result;
        }
      }
    }

    // JS/TS missing semicolons for simple statements (conservative)
    if (['js', 'ts'].includes(ext)) {
      // Only fix obvious like "let x = 1" at end of line without ;
      // Skip for now to avoid false positives
    }

    // Use Monaco markers if provided
    if (ctx.errorMarkers && ctx.errorMarkers.length > 0) {
      const first = ctx.errorMarkers[0];
      const msg = first.message || '';
      if (msg.includes("'}' expected") || msg.includes("')' expected") || msg.includes("']' expected")) {
        // already handled by stack
      }
    }

    return result;
  }

  // ========== LAYER 2: ONLINE AI ==========
  async askAi(userMessage: string, ctx: AiContext): Promise<string> {
    this.isProcessing$.next(true);
    const messages = this.messages$.value;
    messages.push({ role: 'user', content: userMessage, timestamp: Date.now() });
    this.messages$.next([...messages]);

    try {
      // Always run offline first
      const offline = this.runOfflineLinter(ctx);
      if (offline.fixed && offline.newCode) {
        this.lastFix$.next({
          file: ctx.currentFile,
          original: ctx.currentCode,
          fixed: offline.newCode,
          explanation: offline.message
        });
        const reply = offline.message + '\n\nI detected and prepared a fix. Click "Apply Fix" to apply.';
        messages.push({ role: 'assistant', content: reply, timestamp: Date.now() });
        this.messages$.next([...messages]);
        this.isProcessing$.next(false);
        return reply;
      }

      if (!this.apiKey) {
        const reply = 'No API key configured. Go to Settings (gear icon) and paste an OpenAI-compatible API key. Offline linter found no auto-fixable issues.';
        messages.push({ role: 'assistant', content: reply, timestamp: Date.now() });
        this.messages$.next([...messages]);
        this.isProcessing$.next(false);
        return reply;
      }

      // Gather full vision
      let allFilesSummary = '';
      try {
        const all = await this.fs.getAllProjectFiles();
        allFilesSummary = all.map(f => `// FILE: ${f.path}\n${f.content.slice(0, 2000)}${f.content.length > 2000 ? '\n...[truncated]' : ''}`).join('\n\n');
      } catch {
        allFilesSummary = '(could not read project files)';
      }

      const systemPrompt = `You are Zeno, a senior full-stack developer living inside a mobile code editor called Zeno Editor.
You can SEE the user's entire project, open files, errors, and terminal.
Be concise. When fixing code always return a markdown code block with the COMPLETE fixed file content.
Format fixes as:
\`\`\`language
// full fixed code here
\`\`\`
Explain briefly what you changed.`;

      const visionPayload = {
        currentFile: ctx.currentFile,
        currentCode: ctx.currentCode,
        errorMarkers: ctx.errorMarkers,
        terminalOutput: ctx.terminalOutput,
        projectFiles: allFilesSummary.slice(0, 12000),
        userGoal: ctx.userGoal || userMessage
      };

      const body = {
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `VISION CONTEXT:\n${JSON.stringify(visionPayload, null, 2)}\n\nUSER REQUEST: ${userMessage}` }
        ],
        temperature: 0.2,
        max_tokens: 4096
      };

      const resp = await fetch(this.apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body)
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`API ${resp.status}: ${errText.slice(0, 200)}`);
      }

      const data = await resp.json();
      const reply = data.choices?.[0]?.message?.content || 'No response from AI';

      // Try extract code block for fix
      const codeMatch = reply.match(/```(?:\w+)?\n([\s\S]*?)```/);
      if (codeMatch && codeMatch[1] && ctx.currentCode) {
        this.lastFix$.next({
          file: ctx.currentFile,
          original: ctx.currentCode,
          fixed: codeMatch[1].trim(),
          explanation: reply.replace(/```[\s\S]*?```/, '').trim().slice(0, 300)
        });
      }

      messages.push({ role: 'assistant', content: reply, timestamp: Date.now() });
      this.messages$.next([...messages]);
      this.isProcessing$.next(false);
      return reply;
    } catch (e: any) {
      const errMsg = `AI Error: ${e.message || e}`;
      messages.push({ role: 'assistant', content: errMsg, timestamp: Date.now() });
      this.messages$.next([...messages]);
      this.isProcessing$.next(false);
      return errMsg;
    }
  }

  clearChat(): void {
    this.messages$.next([]);
    this.lastFix$.next(null);
  }

  getAllOpenFilesContent(openTabs: { path: string; content: string }[]): string {
    return openTabs.map(t => `// === ${t.path} ===\n${t.content}`).join('\n\n');
  }
}
