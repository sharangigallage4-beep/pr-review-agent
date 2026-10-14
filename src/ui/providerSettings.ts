import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { ProviderError, defaultProviderId, isProviderId, listProviders } from '../review/providers.js';
import type { ProviderId, ProviderInfo } from '../review/providers.js';

/**
 * Which AI provider (Ollama or Claude) new reviews use. The choice made in the UI is kept in a small file
 * so it survives a restart; if that choice is no longer possible (say the Claude key was removed from .env)
 * the .env's own default is used instead. Only the choice is stored - never any key.
 */
export class ProviderSettings {
  private chosen: ProviderId | undefined;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly file?: string
  ) {
    this.load();
  }

  list(): ProviderInfo[] {
    return listProviders(this.env);
  }

  get(): ProviderId {
    const choice = this.chosen;
    if (choice && this.list().find((p) => p.id === choice)?.available) return choice;
    return defaultProviderId(this.env);
  }

  /** Throws a ProviderError, with a message for the user, when the provider is unknown or unusable. */
  set(id: unknown): void {
    if (!isProviderId(id)) throw new ProviderError('Choose "ollama" or "claude".');
    const info = this.list().find((p) => p.id === id);
    if (!info?.available) throw new ProviderError(info?.reason ?? 'That provider is not available.');
    this.chosen = id;
    this.save();
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { provider?: unknown };
      if (isProviderId(saved.provider)) this.chosen = saved.provider;
    } catch {
      // unreadable: fall back to the .env default
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ provider: this.chosen }));
      renameSync(tmp, this.file);
    } catch {
      // best effort
    }
  }
}
