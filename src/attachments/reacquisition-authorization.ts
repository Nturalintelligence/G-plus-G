import crypto from "node:crypto";

export interface ReacquisitionBinding {
  failedArtifactId: string;
  providerId: "gemini";
  projectId: string;
  messageId: string;
}

export interface ReacquisitionTargetRow {
  id: string; status: string; providerId: string; projectId: string; messageId: string;
}

export function validateReacquisitionTarget(input: {
  row: ReacquisitionTargetRow | undefined;
  activeProjectId: string | null;
  assistantTurnMatches: boolean;
  priorAttemptCount: number;
}): ReacquisitionBinding {
  const { row } = input;
  if (!row) throw new Error("Неудачная загрузка не найдена");
  if (row.status !== "FAILED") throw new Error("Повторная проверка доступна только для неудачной загрузки");
  if (row.providerId !== "gemini") throw new Error("Повторная проверка разрешена только для файла Gemini");
  if (!input.activeProjectId || row.projectId !== input.activeProjectId) throw new Error("Файл не принадлежит открытому проекту");
  if (!input.assistantTurnMatches) throw new Error("Связанный ответ Gemini не найден");
  if (input.priorAttemptCount > 0) throw new Error("Лимит ручных попыток для этого файла исчерпан");
  return { failedArtifactId: row.id, providerId: "gemini", projectId: row.projectId, messageId: row.messageId };
}

interface Capability extends ReacquisitionBinding {
  nonce: string;
  expiresAt: number;
}

export class ReacquisitionAuthorization {
  private readonly pending = new Map<string, Capability>();
  private readonly active = new Set<string>();

  public constructor(
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
    private readonly random: (size: number) => Buffer = crypto.randomBytes,
  ) {}

  public reserve(binding: ReacquisitionBinding): boolean {
    if (this.active.has(binding.failedArtifactId)) return false;
    this.active.add(binding.failedArtifactId);
    return true;
  }

  public issueAfterConfirmation(binding: ReacquisitionBinding): string {
    if (!this.active.has(binding.failedArtifactId)) throw new Error("Reacquisition is not reserved");
    const nonce = this.random(32).toString("hex");
    this.pending.set(nonce, { ...binding, nonce, expiresAt: this.now() + this.ttlMs });
    return nonce;
  }

  public consume(nonce: string, binding: ReacquisitionBinding): void {
    const capability = this.pending.get(nonce);
    this.pending.delete(nonce);
    if (!capability || capability.expiresAt <= this.now()) throw new Error("Reacquisition approval expired");
    if (capability.failedArtifactId !== binding.failedArtifactId || capability.providerId !== binding.providerId
      || capability.projectId !== binding.projectId || capability.messageId !== binding.messageId) {
      throw new Error("Reacquisition approval does not match the requested artifact");
    }
  }

  public release(failedArtifactId: string): void {
    this.active.delete(failedArtifactId);
    for (const [nonce, capability] of this.pending) {
      if (capability.failedArtifactId === failedArtifactId) this.pending.delete(nonce);
    }
  }

  public isActive(failedArtifactId: string): boolean { return this.active.has(failedArtifactId); }

  public async runConfirmed<T>(
    binding: ReacquisitionBinding,
    confirm: () => Promise<boolean>,
    action: () => Promise<T>,
  ): Promise<{ confirmed: false } | { confirmed: true; result: T }> {
    if (!this.reserve(binding)) throw new Error("Reacquisition is already active");
    try {
      if (!await confirm()) return { confirmed: false };
      const capability = this.issueAfterConfirmation(binding);
      this.consume(capability, binding);
      return { confirmed: true, result: await action() };
    } finally {
      this.release(binding.failedArtifactId);
    }
  }
}
