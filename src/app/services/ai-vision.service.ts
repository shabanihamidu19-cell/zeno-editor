import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { FilesystemService } from './filesystem.service';

export type AiProvider = 'groq' | 'gemini' | 'openai';

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

/**
 * Model IDs from official docs (checked Oct 2026):
 * - Groq: https://console.groq.com/docs/models
 * - Gemini: https://ai.google.dev/gemini-api/docs (free-tier Flash / Flash-Lite)
 */
export const AI_PROVIDERS: Record<AiProvider, { label: string; endpoint: string; models: string[]; defaultModel: string; free?: boolean }> = {
  groq: {
    label: 'Groq (default, free tier)',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    models: [
      // Production chat (Groq docs)
      'llama-3.1-8b-instant',
      'llama-3.3-70b-versatile',
      'openai/gpt-oss-20b',
      'openai/gpt-oss-120b',
      // Also commonly available on free/dev plans
      'qwen/qwen3.8-27b',
      'allam-2-7b'
    ],
    defaultModel: 'llama-3.1-8b-instant',
    free: true
  },
  gemini: {
    label: 'Google Gemini (free tier)',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    models: [
      // Free of charge on Gemini API free tier (docs / pricing, Oct 2026)
      'gemini-3.8-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      // Legacy aliases still accepted by many projects
      'gemini-2.0-flash',
      'gemini-1.5-flash'
    ],
    defaultModel: 'gemini-3.8-flash',
    free: true
  },
  openai: {
    label: 'OpenAI / Compatible',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    models: [
      'gpt-4o-mini',
      'gpt-4o',
      'gpt-4.1-mini',
      'gpt-4.1',
      'gpt-3.5-turbo'
    ],
    defaultModel: 'gpt-4o-mini'
  }
};

@Injectable({
  providedIn: 'root'
})
export class AiVisionService {
  private apiKey = '';
  private geminiKey = '';
  private provider: AiProvider = 'groq';
  private model = AI_PROVIDERS.groq.defaultModel;

  autoDebugMode$ = new BehaviorSubject<boolean>(false);
  messages$ = new BehaviorSubject<AiMessage[]>([]);
  isProcessing$ = new BehaviorSubject<boolean>(false);
  lastFix$ = new BehaviorSubject<AiFix | null>(null);
  visionActive$ = new BehaviorSubject<boolean>(true);
  provider$ = new BehaviorSubject<AiProvider>('groq');

  private debounceTimer: any;

  constructor(private fs: FilesystemService) {
    this.apiKey = localStorage.getItem('zeno_ai_key') || '';
    this.geminiKey = localStorage.getItem('zeno_gemini_key') || '';
    const p = localStorage.getItem('zeno_ai_provider') as AiProvider;
    if (p && AI_PROVIDERS[p]) {
      this.provider = p;
      this.provider$.next(p);
    }
    const m = localStorage.getItem('zeno_ai_model');
    if (m) this.model = m;
    else this.model = AI_PROVIDERS[this.provider].defaultModel;
  }

  getProvider(): AiProvider {
    return this.provider;
  }

  getModel(): string {
    return this.model;
  }

  setProvider(p: AiProvider): void {
    this.provider = p;
    this.provider$.next(p);
    localStorage.setItem('zeno_ai_provider', p);
    if (!AI_PROVIDERS[p].models.includes(this.model)) {
      this.setModel(AI_PROVIDERS[p].defaultModel);
    }
  }

  setModel(m: string): void {
    this.model = m;
    localStorage.setItem('zeno_ai_model', m);
  }

  setApiKey(key: string): void {
    this.apiKey = key;
    localStorage.setItem('zeno_ai_key', key);
  }

  setGeminiKey(key: string): void {
    this.geminiKey = key;
    localStorage.setItem('zeno_gemini_key', key);
  }

  getApiKeyMasked(): string {
    const k = this.provider === 'gemini' ? this.geminiKey : this.apiKey;
    return k ? '••••' + k.slice(-4) : '';
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

  runOfflineLinter(ctx: AiContext): { fixed: boolean; message: string; newCode?: string } {
    const code = ctx.currentCode;
    const file = ctx.currentFile || '';
    const ext = file.split('.').pop()?.toLowerCase() || '';
    let result = { fixed: false, message: '', newCode: code };

    const openers: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
    const stack: string[] = [];
    let inString = false;
    let stringChar = '';
    let inComment = false;
    let inLineComment = false;

    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      const next = code[i + 1];
      if (inLineComment) { if (ch === '\n') inLineComment = false; continue; }
      if (inComment) { if (ch === '*' && next === '/') { inComment = false; i++; } continue; }
      if (inString) {
        if (ch === '\\') { i++; continue; }
        if (ch === stringChar) inString = false;
        continue;
      }
      if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
      if (ch === '/' && next === '*') { inComment = true; i++; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { inString = true; stringChar = ch; continue; }
      if (ch in openers) stack.push(openers[ch]);
      else if (Object.values(openers).includes(ch)) {
        if (stack.length && stack[stack.length - 1] === ch) stack.pop();
      }
    }

    if (stack.length > 0 && ['js', 'ts', 'tsx', 'jsx', 'json', 'css', 'html'].includes(ext)) {
      let addition = '';
      while (stack.length) addition += stack.pop();
      if (addition) {
        result.newCode = code + '\n' + addition;
        result.fixed = true;
        result.message = `AI Auto-Fixed: Added missing ${addition}`;
        return result;
      }
    }

    if (ext === 'py') {
      const lines = code.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (/^(def|class|if|elif|else|for|while|try|except|finally|with)\b/.test(line) && !line.endsWith(':') && !line.endsWith('\\')) {
          lines[i] = lines[i].replace(/\s*$/, ':');
          result.newCode = lines.join('\n');
          result.fixed = true;
          result.message = `AI Auto-Fixed: Added missing : on line ${i + 1}`;
          return result;
        }
      }
    }
    return result;
  }

  async askAi(userMessage: string, ctx: AiContext): Promise<string> {
    this.isProcessing$.next(true);
    const messages = this.messages$.value;
    messages.push({ role: 'user', content: userMessage, timestamp: Date.now() });
    this.messages$.next([...messages]);

    try {
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

      const key = this.provider === 'gemini' ? this.geminiKey : this.apiKey;
      if (!key) {
        const which = this.provider === 'gemini' ? 'Gemini' : 'Groq/OpenAI';
        const reply = `No ${which} API key set. Open Settings (gear) and paste your free API key.`;
        messages.push({ role: 'assistant', content: reply, timestamp: Date.now() });
        this.messages$.next([...messages]);
        this.isProcessing$.next(false);
        return reply;
      }

      let allFilesSummary = '';
      try {
        const all = await this.fs.getAllProjectFiles();
        allFilesSummary = all
          .map(f => `// FILE: ${f.path}\n${f.content.slice(0, 2000)}${f.content.length > 2000 ? '\n...[truncated]' : ''}`)
          .join('\n\n');
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

      const visionText = `VISION CONTEXT:
currentFile: ${ctx.currentFile}
errorMarkers: ${JSON.stringify(ctx.errorMarkers?.slice(0, 10) || [])}
terminalOutput: ${(ctx.terminalOutput || '').slice(-1500)}

CURRENT CODE:
${ctx.currentCode}

PROJECT FILES (truncated):
${allFilesSummary.slice(0, 10000)}

USER REQUEST: ${userMessage}`;

      let reply = '';
      if (this.provider === 'gemini') {
        reply = await this.callGemini(key, systemPrompt, visionText);
      } else {
        reply = await this.callOpenAICompatible(key, systemPrompt, visionText);
      }

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
      const errMsg = `AI Error (${this.provider}): ${e.message || e}`;
      messages.push({ role: 'assistant', content: errMsg, timestamp: Date.now() });
      this.messages$.next([...messages]);
      this.isProcessing$.next(false);
      return errMsg;
    }
  }

  private async callOpenAICompatible(key: string, systemPrompt: string, userContent: string): Promise<string> {
    const endpoint = AI_PROVIDERS[this.provider].endpoint;
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      temperature: 0.2,
      max_tokens: 4096
    };

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`${resp.status}: ${errText.slice(0, 300)}`);
    }
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || 'No response from AI';
  }

  private async callGemini(key: string, systemPrompt: string, userContent: string): Promise<string> {
    const model = this.model || 'gemini-3.8-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

    const body = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userContent }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4096
      }
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`${resp.status}: ${errText.slice(0, 300)}`);
    }
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || 'No response from Gemini';
    return text;
  }

  clearChat(): void {
    this.messages$.next([]);
    this.lastFix$.next(null);
  }

  getAllOpenFilesContent(openTabs: { path: string; content: string }[]): string {
    return openTabs.map(t => `// === ${t.path} ===\n${t.content}`).join('\n\n');
  }
}
